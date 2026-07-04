import socket

from pythos.network_monitor import (
    NetworkMonitor,
    gradium_probe_target,
    is_network_error,
)


class FakeClock:
    def __init__(self) -> None:
        self.now = 0.0

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


def test_gradium_probe_target_parses_ws_url() -> None:
    assert gradium_probe_target("wss://api.gradium.ai/api") == ("api.gradium.ai", 443)
    assert gradium_probe_target("ws://localhost:9000/api") == ("localhost", 9000)
    assert gradium_probe_target("not a url") is None


def test_is_online_true_when_any_target_answers() -> None:
    attempts: list[str] = []

    def prober(host: str, port: int, timeout: float) -> bool:
        attempts.append(host)
        return host == "8.8.8.8"

    monitor = NetworkMonitor(
        [("api.gradium.ai", 443), ("1.1.1.1", 53), ("8.8.8.8", 53)],
        prober=prober,
        clock=FakeClock(),
    )
    assert monitor.is_online() is True
    assert attempts == ["api.gradium.ai", "1.1.1.1", "8.8.8.8"]


def test_is_online_false_when_all_targets_fail() -> None:
    monitor = NetworkMonitor(
        [("a", 1), ("b", 2)],
        prober=lambda host, port, timeout: False,
        clock=FakeClock(),
    )
    assert monitor.is_online() is False


def test_result_is_cached_within_ttl_and_reprobed_after() -> None:
    clock = FakeClock()
    probes: list[float] = []
    verdict = {"online": True}

    def prober(host: str, port: int, timeout: float) -> bool:
        probes.append(clock.now)
        return verdict["online"]

    monitor = NetworkMonitor([("a", 1)], prober=prober, clock=clock, cache_ttl=3.0)
    assert monitor.is_online() is True
    verdict["online"] = False
    clock.advance(1.0)
    # Still cached: no new probe, stale verdict served.
    assert monitor.is_online() is True
    assert len(probes) == 1
    clock.advance(3.0)
    # TTL expired: re-probe discovers the drop.
    assert monitor.is_online() is False
    assert len(probes) == 2


def test_invalidate_forces_immediate_reprobe() -> None:
    clock = FakeClock()
    verdict = {"online": True}
    monitor = NetworkMonitor(
        [("a", 1)],
        prober=lambda host, port, timeout: verdict["online"],
        clock=clock,
        cache_ttl=60.0,
    )
    assert monitor.is_online() is True
    verdict["online"] = False
    monitor.invalidate()
    assert monitor.is_online() is False


def test_is_network_error_classifies_transport_failures() -> None:
    assert is_network_error(ConnectionResetError("reset")) is True
    assert is_network_error(TimeoutError()) is True
    assert is_network_error(socket.gaierror(8, "nodename nor servname provided")) is True
    assert is_network_error(OSError(51, "Network is unreachable")) is True
    assert is_network_error(RuntimeError("TLS handshake failed unexpectedly")) is True


def test_is_network_error_walks_the_exception_chain() -> None:
    try:
        try:
            raise ConnectionRefusedError("refused")
        except ConnectionRefusedError as inner:
            raise RuntimeError("session died") from inner
    except RuntimeError as outer:
        assert is_network_error(outer) is True


def test_is_network_error_rejects_logic_errors() -> None:
    assert is_network_error(ValueError("bad transcript payload")) is False
    assert is_network_error(RuntimeError("Unexpected STT handshake response: denied")) is False


def test_wake_word_type_name_classification_is_scoped() -> None:
    class ConnectionClosedError(Exception):
        """Mimics websockets.exceptions.ConnectionClosedError by name."""

    assert is_network_error(ConnectionClosedError("gone")) is True
