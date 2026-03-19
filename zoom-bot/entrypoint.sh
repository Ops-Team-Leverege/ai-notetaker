#!/bin/bash
# Entrypoint for zoom-bot container
# Matches the official Zoom meetingsdk-headless-linux-sample setup
# Each step is logged and errors are non-fatal (except the Python bot itself)

echo "[entrypoint] Starting zoom-bot container setup..."

# 1. dbus — required for Zoom SDK internal IPC
echo "[entrypoint] Setting up dbus..."
mkdir -p /var/run/dbus 2>/dev/null
dbus-uuidgen > /var/lib/dbus/machine-id 2>/dev/null
dbus-daemon --config-file=/usr/share/dbus-1/system.conf --print-address 2>/dev/null
DBUS_EXIT=$?
echo "[entrypoint] dbus-daemon exit code: $DBUS_EXIT"

# 2. PulseAudio — clean state, then start in system mode
echo "[entrypoint] Setting up PulseAudio..."
rm -rf /var/run/pulse /var/lib/pulse /root/.config/pulse
mkdir -p /root/.config/pulse
cp -r /etc/pulse/* /root/.config/pulse/ 2>/dev/null
pulseaudio -D --exit-idle-time=-1 --system --disallow-exit 2>/dev/null
PA_EXIT=$?
echo "[entrypoint] pulseaudio exit code: $PA_EXIT"

# 3. Virtual speaker — null sink for headless audio
echo "[entrypoint] Creating virtual speaker..."
sleep 1  # Give PulseAudio a moment to start
pactl load-module module-null-sink sink_name=SpeakerOutput 2>/dev/null
pactl set-default-sink SpeakerOutput 2>/dev/null
pactl set-default-source SpeakerOutput.monitor 2>/dev/null
echo "[entrypoint] Virtual speaker setup done"

# 4. Zoom SDK config
echo "[entrypoint] Writing zoomus.conf..."
mkdir -p /root/.config
echo -e "[General]\nsystem.audio.type=default" > /root/.config/zoomus.conf

# 5. Verify audio setup
echo "[entrypoint] PulseAudio status:"
pactl info 2>&1 | head -5 || echo "[entrypoint] pactl info failed"

echo "[entrypoint] Setup complete, launching bot..."

# 6. Run the bot — this is the only command that MUST succeed
exec python3 -m src.main
