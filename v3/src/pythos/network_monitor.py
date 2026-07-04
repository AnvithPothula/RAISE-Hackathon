"""Network-state detection for the hybrid (cloud/local) voice pipeline.

The worker consults :class:`NetworkMonitor` before every voice turn to decide
whether the streaming Gradium cloud voice is reachable. When it is not — or
when a Gradium stream dies mid-turn — the pipeline swaps to the fully local
Vosk STT + Piper/system TTS engines while the Gemma brain (already local via
Ollama) keeps running uninterrupted.

The probe is a plain TCP connect: it is dependency-free, fails in well under a
second when an interface is down (immediate ENETUNREACH/EHOSTUNREACH), and is
cheap enough to run per turn thanks to a short TTL cache. Probe targets default
to the Gradium API host itself plus two anycast DNS servers, so a captive
portal or a Gradium-only outage both correctly count as "offline" for the
cloud-voice path.
"""

from __future__ import annotations

import socket
import threading
import time
from typing import Callable, Sequence
from urllib.parse import urlparse

from .debug_log import debug

ProbeTarget = tuple[str, int]
Prober = Callable[[str, int, float], bool]

# Anycast DNS endpoints: reachable from effectively any online network, so a
# failure of every target means the machine itself is offline.
_FALLBACK_TARGETS: tuple[ProbeTarget, ...] = (("1.1.1.1", 53), ("8.8.8.8", 53))

_DEFAULT_TIMEOUT_SECONDS = 1.0
_DEFAULT_CACHE_TTL_SECONDS = 3.0


def gradium_probe_target(base_ws_url: str) -> ProbeTarget | None:
    """Derive the (host, port) TCP probe target from a Gradium WebSocket URL."""
    try:
        parsed = urlparse(base_ws_url)
    except ValueError:
        return None
    host = parsed.hostname
    if not host:
        return None
    port = parsed.port or (80 if parsed.scheme in ("ws", "http") else 443)
    return (host, port)


def _tcp_probe(host: str, port: int, timeout: float) -> bool:
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


class NetworkMonitor:
    """Cached reachability checks shared by every voice engine selector.

    ``is_online()`` is safe to call from any thread and from tight per-chunk
    loops: results are cached for ``cache_ttl`` seconds so the probe cost is
    paid at most once per turn in practice. ``invalidate()`` drops the cache,
    which the pipeline calls after a mid-stream network failure so the very
    next turn re-probes instead of trusting a stale "online" verdict.
    """

    def __init__(
        self,
        targets: Sequence[ProbeTarget] | None = None,
        *,
        timeout: float = _DEFAULT_TIMEOUT_SECONDS,
        cache_ttl: float = _DEFAULT_CACHE_TTL_SECONDS,
        prober: Prober = _tcp_probe,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._targets: tuple[ProbeTarget, ...] = tuple(targets) if targets else _FALLBACK_TARGETS
        self._timeout = timeout
        self._cache_ttl = cache_ttl
        self._prober = prober
        self._clock = clock
        self._lock = threading.Lock()
        self._cached: bool | None = None
        self._checked_at = 0.0

    @classmethod
    def for_gradium(cls, base_ws_url: str, **kwargs: object) -> "NetworkMonitor":
        """Monitor probing the Gradium host first, then generic internet targets."""
        gradium = gradium_probe_target(base_ws_url)
        targets: tuple[ProbeTarget, ...] = (
            (gradium, *_FALLBACK_TARGETS) if gradium else _FALLBACK_TARGETS
        )
        return cls(targets, **kwargs)  # type: ignore[arg-type]

    def is_online(self) -> bool:
        """True when any probe target accepts a TCP connection (cached)."""
        now = self._clock()
        with self._lock:
            if self._cached is not None and now - self._checked_at < self._cache_ttl:
                return self._cached

        online = any(self._prober(host, port, self._timeout) for host, port in self._targets)
        with self._lock:
            self._cached = online
            self._checked_at = self._clock()
        if not online:
            debug("network monitor: all probe targets unreachable; treating as offline")
        return online

    def invalidate(self) -> None:
        """Forget the cached verdict (call after a mid-stream network failure)."""
        with self._lock:
            self._cached = None
            self._checked_at = 0.0


# Exception type names that indicate a broken network path rather than a logic
# bug. Matched by name so the classifier needs no imports of optional
# dependencies (the websockets package is only present in the worker venv).
_NETWORK_ERROR_TYPE_NAMES = frozenset(
    {
        "ConnectionClosed",
        "ConnectionClosedError",
        "ConnectionClosedOK",
        "InvalidHandshake",
        "InvalidStatus",
        "InvalidStatusCode",
        "WebSocketException",
        "SecurityError",
        "InvalidURI",
    }
)

_NETWORK_ERROR_MESSAGE_HINTS = (
    "getaddrinfo",
    "name or service not known",
    "nodename nor servname",
    "temporary failure in name resolution",
    "network is unreachable",
    "network is down",
    "no route to host",
    "connection refused",
    "connection reset",
    "connection aborted",
    "timed out",
    "tls",
    "ssl",
    "certificate",
    "socket is not connected",
    "broken pipe",
)


def is_network_error(exc: BaseException) -> bool:
    """Heuristically classify an exception as a network/transport failure.

    Used by the voice pipeline to decide whether a failed Gradium stream should
    trigger the local-engine fallback (network trouble) or surface as a real
    error (anything else, e.g. an authentication rejection with a clear
    message that the user must fix).
    """
    for current in _iter_exception_chain(exc):
        if isinstance(current, (ConnectionError, TimeoutError, socket.gaierror, socket.herror)):
            return True
        if isinstance(current, OSError) and current.errno is not None:
            return True
        if type(current).__name__ in _NETWORK_ERROR_TYPE_NAMES:
            return True
        message = str(current).lower()
        if any(hint in message for hint in _NETWORK_ERROR_MESSAGE_HINTS):
            return True
    return False


def _iter_exception_chain(exc: BaseException):
    seen: set[int] = set()
    current: BaseException | None = exc
    while current is not None and id(current) not in seen:
        seen.add(id(current))
        yield current
        current = current.__cause__ or current.__context__
