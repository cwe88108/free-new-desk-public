package org.freenewdesk.companion;

import android.app.Activity;
import android.os.Bundle;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

/** Explicit foreground-only fixture. Leaving the activity revokes all sessions. */
public final class MainActivity extends Activity {
    private TextView status;
    private final SerialLifecycle<CompanionServer> lifecycle = new SerialLifecycle<>();

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        layout.setPadding(24, 24, 24, 24);
        status = new TextView(this);
        status.setText("Built-in tone fixture only. No external DEX/JAR, WebView, JNI or remote fetch.\nUse a dedicated device and an already-authorized USB connection.");
        Button start = new Button(this); start.setText("Start / rotate pairing");
        start.setOnClickListener(v -> start());
        Button stop = new Button(this); stop.setText("Stop and revoke");
        stop.setOnClickListener(v -> stop());
        layout.addView(status); layout.addView(start); layout.addView(stop);
        setContentView(layout);
    }

    private void start() {
        status.setText("Starting local TLS fixture…");
        lifecycle.start(CompanionServer::new, (candidate, generation) -> {
            candidate.start();
            runOnUiThread(() -> {
                if (!lifecycle.isCurrent(generation)) return;
                status.setText("Loopback TLS port 18765\nSHA-256 certificate pin:\n" + candidate.pin
                    + "\nPairing token (10 minute lifetime):\n" + candidate.token
                    + "\nKeep this screen open. Stop or leave to revoke.\nFixture only, not source compatibility.");
            });
        }, generation -> runOnUiThread(() -> {
            if (lifecycle.isCurrent(generation)) status.setText("Companion startup failed. No runtime enabled.");
        }));
    }

    private void stop() {
        lifecycle.stop();
        if (status != null) status.setText("Stopped. Pairing and media sessions revoked.");
    }
    @Override public void onStop() { stop(); super.onStop(); }
    @Override public void onDestroy() { lifecycle.close(); super.onDestroy(); }
}
