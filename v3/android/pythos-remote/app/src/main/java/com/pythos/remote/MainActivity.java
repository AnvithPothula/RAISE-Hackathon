package com.pythos.remote;

import android.Manifest;
import android.app.Activity;
import android.app.Dialog;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.LinearGradient;
import android.graphics.Paint;
import android.graphics.RadialGradient;
import android.graphics.Shader;
import android.graphics.Typeface;
import android.graphics.drawable.ColorDrawable;
import android.graphics.drawable.GradientDrawable;
import android.media.MediaPlayer;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.InputType;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.view.inputmethod.EditorInfo;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import java.io.File;
import java.util.Locale;
import java.util.UUID;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public final class MainActivity extends Activity {
    private static final int REQUEST_RECORD_AUDIO = 41;
    private static final int BG = Color.rgb(9, 11, 16);
    private static final int PANEL = Color.rgb(12, 17, 25);
    private static final int PANEL_2 = Color.rgb(17, 25, 35);
    private static final int TEXT = Color.rgb(239, 246, 255);
    private static final int MUTED = Color.rgb(142, 167, 199);
    private static final int ACCENT = Color.rgb(104, 228, 191);
    private static final int BLUE = Color.rgb(73, 122, 255);
    private static final int GOLD = Color.rgb(243, 201, 107);
    private static final int RED = Color.rgb(255, 107, 107);

    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private final Handler main = new Handler(Looper.getMainLooper());
    private final WavRecorder recorder = new WavRecorder();
    private final Runnable heartbeat = new Runnable() {
        @Override
        public void run() {
            PythosClient current = client;
            if (current != null) {
                executor.execute(() -> {
                    try {
                        current.sendDeviceEvent("heartbeat", deviceId, sessionId, deviceName());
                    } catch (Exception ignored) {
                        main.post(() -> {
                            setConnected(false);
                            setStatus("Needs attention");
                            setDetail("Heartbeat failed. Check Tailscale and the server URL.");
                        });
                    }
                });
                main.postDelayed(this, 15000);
            }
        }
    };

    private SharedPreferences prefs;
    private EditText promptInput;
    private TextView statusTitle;
    private TextView statusPill;
    private TextView detailText;
    private TextView replyText;
    private Button connectButton;
    private Button recordButton;
    private Button sendButton;
    private Button settingsButton;
    private Button stopButton;
    private PythosOrbView orbView;
    private PythosClient client;
    private MediaPlayer player;
    private File activeRecording;
    private String deviceId;
    private String sessionId;
    private String serverUrl;
    private String nodeName;
    private boolean connected;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        prefs = getSharedPreferences("pythos-remote", MODE_PRIVATE);
        deviceId = prefs.getString("device_id", "");
        if (deviceId.isEmpty()) {
            deviceId = "android-" + UUID.randomUUID().toString();
            prefs.edit().putString("device_id", deviceId).apply();
        }
        sessionId = UUID.randomUUID().toString();
        serverUrl = normalizeServerUrl(prefs.getString("server_url", ""));
        nodeName = prefs.getString("device_name", defaultDeviceName());
        setContentView(buildLayout());
        refreshSettingsSummary();
        if (serverUrl.trim().isEmpty()) {
            setStatus("Needs setup");
            setDetail("Open settings and enter the PC Tailscale URL.");
        }
    }

    @Override
    protected void onDestroy() {
        main.removeCallbacks(heartbeat);
        PythosClient current = client;
        if (current != null) {
            executor.execute(() -> {
                try {
                    current.sendDeviceEvent("offline", deviceId, sessionId, deviceName());
                } catch (Exception ignored) {
                    // Best effort only; the desktop will also remove stale nodes through later events.
                }
            });
        }
        if (recorder.isRecording()) {
            try {
                recorder.stop();
            } catch (Exception ignored) {
                // Activity is closing.
            }
        }
        releasePlayer();
        executor.shutdown();
        super.onDestroy();
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == REQUEST_RECORD_AUDIO) {
            if (grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
                startRecording();
            } else {
                setStatus("Needs attention");
                setDetail("Microphone permission is required for voice prompts.");
                orbView.setMode("error");
            }
        }
    }

    private View buildLayout() {
        ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        scroll.setBackgroundColor(BG);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(dp(20), dp(22), dp(20), dp(26));
        scroll.addView(root, new ScrollView.LayoutParams(-1, -2));

        LinearLayout topbar = new LinearLayout(this);
        topbar.setOrientation(LinearLayout.HORIZONTAL);
        topbar.setGravity(Gravity.CENTER_VERTICAL);
        root.addView(topbar, blockParams());

        LinearLayout heading = new LinearLayout(this);
        heading.setOrientation(LinearLayout.VERTICAL);
        topbar.addView(heading, new LinearLayout.LayoutParams(0, -2, 1f));

        TextView eyebrow = label("Pythos v3");
        heading.addView(eyebrow);

        statusTitle = new TextView(this);
        statusTitle.setText("Disconnected");
        statusTitle.setTextColor(TEXT);
        statusTitle.setTextSize(32);
        statusTitle.setTypeface(Typeface.DEFAULT_BOLD);
        statusTitle.setIncludeFontPadding(false);
        heading.addView(statusTitle);

        LinearLayout topActions = new LinearLayout(this);
        topActions.setOrientation(LinearLayout.VERTICAL);
        topActions.setGravity(Gravity.END);
        topbar.addView(topActions);

        statusPill = pill("Not connected");
        topActions.addView(statusPill, smallBlockParams());

        settingsButton = button("Settings", PANEL_2, TEXT);
        settingsButton.setMinHeight(dp(38));
        settingsButton.setTextSize(13);
        settingsButton.setOnClickListener(view -> showSettingsDialog());
        topActions.addView(settingsButton, new LinearLayout.LayoutParams(dp(108), dp(40)));

        detailText = new TextView(this);
        detailText.setTextColor(MUTED);
        detailText.setTextSize(14);
        detailText.setLineSpacing(dp(2), 1.0f);
        root.addView(detailText, blockParams());

        orbView = new PythosOrbView(this);
        root.addView(orbView, new LinearLayout.LayoutParams(-1, dp(310)));

        LinearLayout controls = new LinearLayout(this);
        controls.setOrientation(LinearLayout.HORIZONTAL);
        controls.setGravity(Gravity.CENTER);
        controls.setBaselineAligned(false);
        root.addView(controls, blockParams());

        connectButton = button("Connect", PANEL_2, TEXT);
        connectButton.setOnClickListener(view -> connect());
        controls.addView(connectButton, controlParams());

        recordButton = button("Talk", ACCENT, Color.rgb(7, 16, 22));
        recordButton.setOnClickListener(view -> toggleRecording());
        recordButton.setOnTouchListener((view, event) -> {
            if (event.getAction() == MotionEvent.ACTION_CANCEL && recorder.isRecording()) {
                toggleRecording();
            }
            return false;
        });
        controls.addView(recordButton, controlParams());

        stopButton = button("Stop", PANEL_2, TEXT);
        stopButton.setOnClickListener(view -> {
            releasePlayer();
            if (recorder.isRecording()) {
                try {
                    recorder.stop();
                } catch (Exception ignored) {
                    // User requested a stop; the next prompt can start cleanly.
                }
                recordButton.setText("Talk");
            }
            setStatus(connected ? "Ready" : "Disconnected");
            setDetail(settingsDetail());
            orbView.setMode("idle");
        });
        controls.addView(stopButton, controlParams());

        LinearLayout promptRow = new LinearLayout(this);
        promptRow.setOrientation(LinearLayout.HORIZONTAL);
        promptRow.setGravity(Gravity.CENTER_VERTICAL);
        root.addView(promptRow, blockParams());

        promptInput = input("Type to Pythos");
        promptInput.setSingleLine(false);
        promptInput.setMinLines(1);
        promptInput.setMaxLines(3);
        promptInput.setGravity(Gravity.CENTER_VERTICAL | Gravity.START);
        promptInput.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_MULTI_LINE);
        promptInput.setImeOptions(EditorInfo.IME_ACTION_SEND);
        promptRow.addView(promptInput, new LinearLayout.LayoutParams(0, dp(52), 1f));

        sendButton = button("Send", ACCENT, Color.rgb(7, 16, 22));
        sendButton.setOnClickListener(view -> sendPrompt());
        LinearLayout.LayoutParams sendParams = new LinearLayout.LayoutParams(dp(78), dp(52));
        sendParams.setMargins(dp(10), 0, 0, 0);
        promptRow.addView(sendButton, sendParams);

        LinearLayout replyPanel = new LinearLayout(this);
        replyPanel.setOrientation(LinearLayout.VERTICAL);
        replyPanel.setPadding(dp(14), dp(14), dp(14), dp(14));
        replyPanel.setBackground(panelDrawable(PANEL, Color.argb(36, 255, 255, 255)));
        root.addView(replyPanel, blockParams());

        TextView replyLabel = label("Conversation");
        replyPanel.addView(replyLabel, smallBlockParams());

        replyText = new TextView(this);
        replyText.setText("Replies from the PC will appear here.");
        replyText.setTextColor(TEXT);
        replyText.setTextSize(15);
        replyText.setLineSpacing(dp(3), 1.0f);
        replyPanel.addView(replyText);

        return scroll;
    }

    private void showSettingsDialog() {
        Dialog dialog = new Dialog(this);
        dialog.requestWindowFeature(Window.FEATURE_NO_TITLE);

        LinearLayout panel = new LinearLayout(this);
        panel.setOrientation(LinearLayout.VERTICAL);
        panel.setPadding(dp(20), dp(18), dp(20), dp(18));
        panel.setBackground(panelDrawable(PANEL, Color.argb(48, 255, 255, 255)));

        LinearLayout header = new LinearLayout(this);
        header.setOrientation(LinearLayout.HORIZONTAL);
        header.setGravity(Gravity.CENTER_VERTICAL);
        panel.addView(header, blockParams());

        LinearLayout titleStack = new LinearLayout(this);
        titleStack.setOrientation(LinearLayout.VERTICAL);
        header.addView(titleStack, new LinearLayout.LayoutParams(0, -2, 1f));
        titleStack.addView(label("Runtime"));

        TextView title = new TextView(this);
        title.setText("Settings");
        title.setTextColor(TEXT);
        title.setTextSize(24);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        titleStack.addView(title);

        Button close = button("Close", PANEL_2, TEXT);
        close.setMinHeight(dp(38));
        close.setOnClickListener(view -> dialog.dismiss());
        header.addView(close, new LinearLayout.LayoutParams(dp(86), dp(40)));

        panel.addView(label("Server URL"));
        EditText server = input("http://100.x.y.z:9000");
        server.setText(serverUrl);
        server.setSingleLine(true);
        panel.addView(server, blockParams());

        panel.addView(label("Node name"));
        EditText name = input(defaultDeviceName());
        name.setText(nodeName);
        name.setSingleLine(true);
        panel.addView(name, blockParams());

        panel.addView(settingReadout("Device ID", deviceId));
        panel.addView(settingReadout("Session", sessionId));

        LinearLayout actions = new LinearLayout(this);
        actions.setOrientation(LinearLayout.HORIZONTAL);
        actions.setGravity(Gravity.END);
        panel.addView(actions, blockParams());

        Button save = button("Save", PANEL_2, TEXT);
        save.setOnClickListener(view -> {
            saveSettings(server.getText().toString(), name.getText().toString());
            dialog.dismiss();
        });
        actions.addView(save, actionParams());

        Button saveConnect = button("Save + Connect", ACCENT, Color.rgb(7, 16, 22));
        saveConnect.setOnClickListener(view -> {
            saveSettings(server.getText().toString(), name.getText().toString());
            dialog.dismiss();
            connect();
        });
        actions.addView(saveConnect, new LinearLayout.LayoutParams(dp(142), dp(46)));

        dialog.setContentView(panel);
        dialog.show();
        Window window = dialog.getWindow();
        if (window != null) {
            window.setBackgroundDrawable(new ColorDrawable(Color.TRANSPARENT));
            WindowManager.LayoutParams attrs = new WindowManager.LayoutParams();
            attrs.copyFrom(window.getAttributes());
            attrs.width = Math.min(getResources().getDisplayMetrics().widthPixels - dp(32), dp(560));
            attrs.height = WindowManager.LayoutParams.WRAP_CONTENT;
            window.setAttributes(attrs);
        }
    }

    private void saveSettings(String nextServerUrl, String nextNodeName) {
        serverUrl = normalizeServerUrl(nextServerUrl);
        nodeName = nextNodeName == null || nextNodeName.trim().isEmpty() ? defaultDeviceName() : nextNodeName.trim();
        prefs.edit()
            .putString("server_url", serverUrl)
            .putString("device_name", nodeName)
            .apply();
        client = null;
        main.removeCallbacks(heartbeat);
        setConnected(false);
        refreshSettingsSummary();
        setStatus(serverUrl.isEmpty() ? "Needs setup" : "Disconnected");
        orbView.setMode("idle");
    }

    private void connect() {
        try {
            PythosClient current = ensureClient();
            runTask(
                "Thinking",
                "thinking",
                () -> {
                    current.health();
                    current.sendDeviceEvent("online", deviceId, sessionId, deviceName());
                    return "Ready";
                },
                status -> {
                    setConnected(true);
                    setStatus(status);
                    orbView.setMode("idle");
                    setDetail(settingsDetail());
                    main.removeCallbacks(heartbeat);
                    main.postDelayed(heartbeat, 15000);
                }
            );
            setDetail("Connecting to " + displayServerUrl() + ".");
        } catch (Exception error) {
            setConnected(false);
            setStatus("Needs setup");
            setDetail(error.getMessage());
            orbView.setMode("error");
        }
    }

    private void sendPrompt() {
        String prompt = promptInput.getText().toString().trim();
        if (prompt.isEmpty()) {
            return;
        }
        try {
            PythosClient current = ensureClient();
            promptInput.setText("");
            runTask(
                "Thinking",
                "thinking",
                () -> current.sendText(prompt, deviceId, sessionId, deviceName()),
                this::showResponse
            );
        } catch (Exception error) {
            setStatus("Needs setup");
            setDetail(error.getMessage());
            orbView.setMode("error");
        }
    }

    private void toggleRecording() {
        if (recorder.isRecording()) {
            stopRecordingAndSend();
            return;
        }
        if (Build.VERSION.SDK_INT >= 23 && checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[] { Manifest.permission.RECORD_AUDIO }, REQUEST_RECORD_AUDIO);
            return;
        }
        startRecording();
    }

    private void startRecording() {
        try {
            ensureClient();
            activeRecording = File.createTempFile("pythos-remote-", ".wav", getCacheDir());
            recorder.start(activeRecording);
            recordButton.setText("Stop");
            setStatus("Listening");
            orbView.setMode("listening");
            setDetail("Recording voice prompt for " + deviceName() + ".");
        } catch (Exception error) {
            setStatus("Needs attention");
            setDetail(error.getMessage());
            orbView.setMode("error");
        }
    }

    private void stopRecordingAndSend() {
        PythosClient current;
        try {
            current = ensureClient();
        } catch (Exception error) {
            setStatus("Needs setup");
            setDetail(error.getMessage());
            orbView.setMode("error");
            return;
        }
        File file = activeRecording;
        if (file == null) {
            setDetail("No recording is active.");
            return;
        }
        recordButton.setEnabled(false);
        runTask(
            "Thinking",
            "thinking",
            () -> {
                recorder.stop();
                return current.uploadAudio(file, deviceId, sessionId, deviceName());
            },
            response -> {
                recordButton.setEnabled(true);
                recordButton.setText("Talk");
                showResponse(response);
            }
        );
        setDetail("Uploading voice prompt to the PC.");
    }

    private PythosClient ensureClient() {
        String server = serverUrl == null ? "" : serverUrl.trim();
        if (server.isEmpty()) {
            throw new IllegalStateException("Set the Pythos server URL in Settings first.");
        }
        client = new PythosClient(server);
        return client;
    }

    private void showResponse(RemoteResponse response) {
        setConnected(true);
        replyText.setText(response.text.isEmpty() ? "No reply text returned." : response.text);
        if (!response.audioUrl.isEmpty()) {
            setStatus("Speaking");
            orbView.setMode("speaking");
            setDetail("Playing reply from the PC.");
            playAudio(response.audioUrl);
        } else {
            setStatus("Ready");
            orbView.setMode("idle");
            setDetail(settingsDetail());
        }
    }

    private void playAudio(String url) {
        PythosClient current = client;
        if (current == null) {
            return;
        }
        releasePlayer();
        player = new MediaPlayer();
        try {
            player.setDataSource(current.absoluteUrl(url));
            player.setOnPreparedListener(mediaPlayer -> {
                setStatus("Speaking");
                orbView.setMode("speaking");
                mediaPlayer.start();
            });
            player.setOnCompletionListener(mediaPlayer -> {
                mediaPlayer.release();
                if (player == mediaPlayer) {
                    player = null;
                }
                setStatus("Ready");
                orbView.setMode("idle");
                setDetail(settingsDetail());
            });
            player.setOnErrorListener((mediaPlayer, what, extra) -> {
                setStatus("Needs attention");
                setDetail("Reply audio could not play.");
                orbView.setMode("error");
                mediaPlayer.release();
                if (player == mediaPlayer) {
                    player = null;
                }
                return true;
            });
            player.prepareAsync();
        } catch (Exception error) {
            setStatus("Needs attention");
            setDetail("Reply audio failed: " + error.getMessage());
            orbView.setMode("error");
            releasePlayer();
        }
    }

    private void releasePlayer() {
        if (player != null) {
            player.release();
            player = null;
        }
    }

    private <T> void runTask(String status, String orbMode, Callable<T> task, UiCallback<T> callback) {
        setBusy(true);
        setStatus(status);
        if (orbMode != null && !orbMode.isEmpty()) {
            orbView.setMode(orbMode);
        }
        executor.execute(() -> {
            try {
                T result = task.call();
                main.post(() -> {
                    setBusy(false);
                    callback.run(result);
                });
            } catch (Exception error) {
                main.post(() -> {
                    setBusy(false);
                    recordButton.setEnabled(true);
                    if (!recorder.isRecording()) {
                        recordButton.setText("Talk");
                    }
                    setConnected(false);
                    setStatus("Needs attention");
                    setDetail(error.getMessage());
                    if (orbMode != null && !orbMode.isEmpty()) {
                        orbView.setMode("error");
                    }
                });
            }
        });
    }

    private void setBusy(boolean busy) {
        connectButton.setEnabled(!busy);
        sendButton.setEnabled(!busy);
        settingsButton.setEnabled(!busy);
        recordButton.setEnabled(!busy);
        stopButton.setEnabled(!busy);
    }

    private void setStatus(String value) {
        String status = value == null || value.isEmpty() ? "Ready" : value;
        statusTitle.setText(status);
        statusPill.setText(statusPillText(status));
    }

    private void setDetail(String value) {
        detailText.setText(value == null || value.isEmpty() ? settingsDetail() : value);
    }

    private void setConnected(boolean value) {
        connected = value;
        refreshSettingsSummary();
    }

    private void refreshSettingsSummary() {
        if (detailText != null) {
            detailText.setText(settingsDetail());
        }
        if (orbView != null) {
            orbView.invalidate();
        }
    }

    private String settingsDetail() {
        if (serverUrl == null || serverUrl.trim().isEmpty()) {
            return "Server URL is not configured.";
        }
        return deviceName() + " -> " + displayServerUrl();
    }

    private String displayServerUrl() {
        String value = serverUrl == null ? "" : serverUrl.trim();
        return value.isEmpty() ? "not configured" : value;
    }

    private static String normalizeServerUrl(String value) {
        String trimmed = value == null ? "" : value.trim();
        if (trimmed.isEmpty()) {
            return "";
        }
        try {
            return PythosClient.normalizeBaseUrl(trimmed);
        } catch (IllegalArgumentException ignored) {
            return trimmed;
        }
    }

    private String deviceName() {
        String value = nodeName == null ? "" : nodeName.trim();
        return value.isEmpty() ? defaultDeviceName() : value;
    }

    private static String statusPillText(String status) {
        String normalized = status.toLowerCase(Locale.US);
        if (normalized.contains("ready")) return "Connected";
        if (normalized.contains("listening")) return "Mic active";
        if (normalized.contains("thinking")) return "PC working";
        if (normalized.contains("speaking")) return "Reply audio";
        if (normalized.contains("setup")) return "Settings";
        if (normalized.contains("attention")) return "Check config";
        return "Remote node";
    }

    private static String defaultDeviceName() {
        String maker = Build.MANUFACTURER == null ? "" : Build.MANUFACTURER.trim();
        String model = Build.MODEL == null ? "Android" : Build.MODEL.trim();
        if (!maker.isEmpty() && model.toLowerCase(Locale.US).startsWith(maker.toLowerCase(Locale.US))) {
            return model;
        }
        return (maker + " " + model).trim();
    }

    private TextView label(String text) {
        TextView label = new TextView(this);
        label.setText(text);
        label.setTextColor(MUTED);
        label.setTextSize(12);
        label.setTypeface(Typeface.DEFAULT_BOLD);
        label.setAllCaps(true);
        label.setIncludeFontPadding(false);
        return label;
    }

    private TextView pill(String text) {
        TextView view = new TextView(this);
        view.setText(text);
        view.setTextColor(MUTED);
        view.setTextSize(12);
        view.setGravity(Gravity.CENTER);
        view.setSingleLine(true);
        view.setPadding(dp(10), 0, dp(10), 0);
        view.setMinHeight(dp(34));
        view.setBackground(panelDrawable(Color.argb(18, 255, 255, 255), Color.argb(28, 255, 255, 255)));
        return view;
    }

    private TextView settingReadout(String label, String value) {
        TextView view = new TextView(this);
        view.setText(label + "\n" + value);
        view.setTextColor(MUTED);
        view.setTextSize(12);
        view.setLineSpacing(dp(2), 1.0f);
        view.setPadding(dp(12), dp(10), dp(12), dp(10));
        view.setBackground(panelDrawable(Color.argb(14, 255, 255, 255), Color.argb(24, 255, 255, 255)));
        return view;
    }

    private EditText input(String hint) {
        EditText editText = new EditText(this);
        editText.setHint(hint);
        editText.setHintTextColor(Color.rgb(99, 122, 152));
        editText.setTextColor(TEXT);
        editText.setTextSize(15);
        editText.setSingleLine(true);
        editText.setPadding(dp(12), 0, dp(12), 0);
        editText.setMinHeight(dp(48));
        editText.setBackground(panelDrawable(PANEL_2, Color.argb(32, 255, 255, 255)));
        return editText;
    }

    private Button button(String text, int bg, int fg) {
        Button button = new Button(this);
        button.setText(text);
        button.setTextColor(fg);
        button.setTextSize(14);
        button.setAllCaps(false);
        button.setMinHeight(dp(48));
        button.setPadding(dp(8), 0, dp(8), 0);
        button.setBackground(panelDrawable(bg, Color.argb(34, 255, 255, 255)));
        return button;
    }

    private GradientDrawable panelDrawable(int fill, int stroke) {
        GradientDrawable drawable = new GradientDrawable();
        drawable.setColor(fill);
        drawable.setCornerRadius(dp(8));
        drawable.setStroke(dp(1), stroke);
        return drawable;
    }

    private LinearLayout.LayoutParams blockParams() {
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, -2);
        params.setMargins(0, 0, 0, dp(14));
        return params;
    }

    private LinearLayout.LayoutParams smallBlockParams() {
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-2, -2);
        params.setMargins(0, 0, 0, dp(8));
        return params;
    }

    private LinearLayout.LayoutParams controlParams() {
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(0, dp(52), 1f);
        params.setMargins(dp(4), 0, dp(4), 0);
        return params;
    }

    private LinearLayout.LayoutParams actionParams() {
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(dp(92), dp(46));
        params.setMargins(0, 0, dp(10), 0);
        return params;
    }

    private int dp(int value) {
        return (int) (value * getResources().getDisplayMetrics().density + 0.5f);
    }

    private interface UiCallback<T> {
        void run(T value);
    }

    private static final class PythosOrbView extends View {
        private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        private String mode = "idle";

        PythosOrbView(Activity context) {
            super(context);
            setLayerType(View.LAYER_TYPE_SOFTWARE, null);
        }

        void setMode(String value) {
            mode = value == null ? "idle" : value;
            invalidate();
        }

        @Override
        protected void onDraw(Canvas canvas) {
            super.onDraw(canvas);
            int width = getWidth();
            int height = getHeight();
            float cx = width / 2f;
            float cy = height / 2f;
            long now = System.currentTimeMillis();
            float viewSize = Math.min(width, height);
            float orbRadius = viewSize * 0.41f;
            float coreRadius = orbRadius * 0.52f;
            float ringOneRadius = orbRadius * 0.70f;
            float ringTwoRadius = orbRadius * 0.88f;
            float pulse = breathePulse(now);
            float breatheScale = isBreatheActive() ? 0.96f + pulse * 0.12f : 1f;
            float breatheAlpha = isBreatheActive() ? 0.64f + pulse * 0.36f : 1f;

            paint.setShader(new RadialGradient(
                cx,
                cy,
                orbRadius * 1.24f,
                new int[] { colorWithAlpha(Color.rgb(78, 201, 176), 54), colorWithAlpha(Color.rgb(84, 135, 255), 56), Color.TRANSPARENT },
                new float[] { 0f, 0.55f, 1f },
                Shader.TileMode.CLAMP
            ));
            canvas.drawCircle(cx, cy, orbRadius * 1.24f, paint);
            paint.setShader(null);

            paint.setStyle(Paint.Style.STROKE);
            paint.setStrokeWidth(2f);
            paint.setColor(colorWithAlpha(Color.rgb(122, 220, 198), (int) (66 * breatheAlpha)));
            canvas.drawCircle(cx, cy, ringOneRadius * breatheScale, paint);
            paint.setColor(colorWithAlpha(Color.rgb(92, 132, 255), (int) (52 * breatheAlpha)));
            canvas.drawCircle(cx, cy, ringTwoRadius * breatheScale, paint);

            paint.setStyle(Paint.Style.FILL);
            paint.setShader(new LinearGradient(
                cx - coreRadius,
                cy - coreRadius,
                cx + coreRadius,
                cy + coreRadius,
                coreGradientColors(),
                coreGradientStops(),
                Shader.TileMode.CLAMP
            ));
            paint.setShadowLayer(28f, 0, 0, colorWithAlpha(modeAccent(), 82));
            canvas.drawCircle(cx, cy, coreRadius, paint);
            paint.clearShadowLayer();
            paint.setShader(null);

            paint.setShader(new RadialGradient(
                cx - coreRadius * 0.28f,
                cy - coreRadius * 0.44f,
                coreRadius * 0.22f,
                colorWithAlpha(Color.WHITE, 230),
                Color.TRANSPARENT,
                Shader.TileMode.CLAMP
            ));
            canvas.drawCircle(cx - coreRadius * 0.28f, cy - coreRadius * 0.44f, coreRadius * 0.22f, paint);
            paint.setShader(null);

            postInvalidateDelayed(33);
        }

        private float breathePulse(long now) {
            double phase = (now % 1800L) / 1800.0;
            return (float) ((1.0 - Math.cos(phase * Math.PI * 2.0)) / 2.0);
        }

        private boolean isBreatheActive() {
            return "listening".equals(mode) || "thinking".equals(mode) || "speaking".equals(mode);
        }

        private int[] coreGradientColors() {
            if ("thinking".equals(mode)) {
                return new int[] { GOLD, Color.rgb(91, 130, 255), Color.rgb(17, 24, 39) };
            }
            if ("speaking".equals(mode)) {
                return new int[] { Color.rgb(92, 229, 186), Color.rgb(240, 123, 101), Color.rgb(17, 24, 39) };
            }
            if ("error".equals(mode)) {
                return new int[] { RED, Color.rgb(141, 31, 63), Color.rgb(141, 31, 63) };
            }
            return new int[] { Color.rgb(98, 230, 189), BLUE, Color.rgb(16, 26, 42) };
        }

        private float[] coreGradientStops() {
            if ("error".equals(mode)) {
                return new float[] { 0f, 1f, 1f };
            }
            return new float[] { 0f, 0.56f, 1f };
        }

        private int modeAccent() {
            if ("listening".equals(mode)) return ACCENT;
            if ("thinking".equals(mode)) return GOLD;
            if ("speaking".equals(mode)) return Color.rgb(240, 123, 101);
            if ("error".equals(mode)) return RED;
            return Color.rgb(98, 230, 189);
        }

        private static int colorWithAlpha(int color, int alpha) {
            return Color.argb(alpha, Color.red(color), Color.green(color), Color.blue(color));
        }
    }
}
