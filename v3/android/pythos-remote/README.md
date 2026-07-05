# Pythos Remote Android

Native Android client for the Pythos v3 desktop bridge.

## What it does

- Sends typed prompts to the PC through the Pythos bridge.
- Records a 16 kHz mono WAV prompt, uploads it, and plays the WAV reply returned by the PC.
- Sends online, heartbeat, and offline events so the phone appears as an orbiting node in the desktop UI.
- Keeps command execution on the desktop PC. For example, `open excel` launches Excel on the PC, not on the phone.

## Desktop setup

Run Pythos v3 on the desktop (macOS, Windows, or Linux) while Tailscale is connected:

```bash
cd path/to/RAISE-Hackathon/v3
npm run dev
```

The bridge listens on port `9000` on all interfaces. In the Android app, use:

```text
http://<pc-tailscale-ip-or-magicdns-name>:9000
```

Examples:

```text
100.101.102.103
100.101.102.103:9000
http://100.101.102.103:9000
http://my-pc.tailnet-name.ts.net:9000
```

If you enter only an IP or hostname, the app adds `http://` and `:9000` automatically.

Open **Settings** in the app to save the server URL and node name. Use **Save + Connect** to make the phone appear as an orbiting node in the desktop UI immediately.

## Build/install

Open `v3/android/pythos-remote` in Android Studio, let Gradle sync, then run it on the phone.

The app needs microphone permission for voice prompts and cleartext HTTP because the private Tailscale URL is normally `http://`.
