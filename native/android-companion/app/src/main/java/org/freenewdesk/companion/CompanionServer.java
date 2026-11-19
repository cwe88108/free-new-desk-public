package org.freenewdesk.companion;

import android.os.Build;
import android.os.SystemClock;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.*;
import java.net.*;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.security.*;
import java.security.cert.X509Certificate;
import java.util.*;
import java.util.concurrent.*;
import javax.net.ssl.*;
import javax.security.auth.x500.X500Principal;

/** Bounded, pinned-TLS transport proof. Intentionally contains NO external-code loader. */
final class CompanionServer implements AutoCloseable {
    static final String PROFILE = "builtin-tone-v1";
    static final String SOURCE = "android-builtin-tone";
    final String token = random();
    final String pin;
    private final String alias = "fnd-fixture-" + random();
    private final SSLServerSocket listener;
    private final Set<Socket> sockets = ConcurrentHashMap.newKeySet();
    private final ThreadPoolExecutor workers = new ThreadPoolExecutor(2, 2, 0, TimeUnit.SECONDS,
        new ArrayBlockingQueue<>(2), new ThreadPoolExecutor.AbortPolicy());
    private final ScheduledThreadPoolExecutor deadlines = new ScheduledThreadPoolExecutor(1);
    private final long expires = SystemClock.elapsedRealtime() + 600_000;
    private volatile boolean closed;
    private Session session;
    private final byte[] media = tone();

    private static final class Session {
        final String id = random(), handle = random(), revision;
        final ResourceLease resources = new ResourceLease();
        ScheduledFuture<?> expiry;
        final long expires = SystemClock.elapsedRealtime() + 120_000;
        Session(String revision) { this.revision = revision; }
    }

    CompanionServer() throws Exception {
        SSLServerSocket opened = null;
        try {
            KeyPairGenerator generator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore");
            generator.initialize(new KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN | KeyProperties.PURPOSE_VERIFY)
                .setDigests(KeyProperties.DIGEST_SHA256, KeyProperties.DIGEST_SHA512)
                .setCertificateSubject(new X500Principal("CN=FND local fixture"))
                .setCertificateNotBefore(new Date(System.currentTimeMillis() - 60_000))
                .setCertificateNotAfter(new Date(System.currentTimeMillis() + 86400_000)).build());
            generator.generateKeyPair();
            KeyStore store = KeyStore.getInstance("AndroidKeyStore"); store.load(null);
            PrivateKey key = (PrivateKey) store.getKey(alias, null);
            X509Certificate certificate = (X509Certificate) store.getCertificate(alias);
            pin = hex(MessageDigest.getInstance("SHA-256").digest(certificate.getEncoded()));
            X509ExtendedKeyManager manager = new X509ExtendedKeyManager() {
                public String[] getClientAliases(String type, Principal[] issuers) { return null; }
                public String chooseClientAlias(String[] types, Principal[] issuers, Socket socket) { return null; }
                public String[] getServerAliases(String type, Principal[] issuers) { return "EC".equals(type) ? new String[]{alias} : null; }
                public String chooseServerAlias(String type, Principal[] issuers, Socket socket) { return "EC".equals(type) ? alias : null; }
                public X509Certificate[] getCertificateChain(String requested) { return alias.equals(requested) ? new X509Certificate[]{certificate} : null; }
                public PrivateKey getPrivateKey(String requested) { return alias.equals(requested) ? key : null; }
            };
            SSLContext tls = SSLContext.getInstance("TLSv1.2");
            tls.init(new KeyManager[]{manager}, null, new SecureRandom());
            opened = (SSLServerSocket) tls.getServerSocketFactory().createServerSocket();
            opened.setEnabledProtocols(new String[]{"TLSv1.2"});
            opened.bind(new InetSocketAddress(InetAddress.getByName("127.0.0.1"), 18765), 4);
            listener = opened;
        } catch (Exception error) {
            if (opened != null) try { opened.close(); } catch (IOException ignored) { }
            deleteKey();
            throw error;
        }
    }

    void start() {
        deadlines.setRemoveOnCancelPolicy(true);
        deadlines.schedule(this::close, 600_000, TimeUnit.MILLISECONDS);
        new Thread(() -> {
            while (!closed) {
                try {
                    SSLSocket socket = (SSLSocket) listener.accept();
                    socket.setSoTimeout(5000);
                    synchronized (this) {
                        if (closed) { socket.close(); continue; }
                        sockets.add(socket);
                    }
                    try {
                        ScheduledFuture<?> deadline = deadlines.schedule(() -> {
                            try { socket.close(); } catch (IOException ignored) { }
                        }, 5, TimeUnit.SECONDS);
                        try { workers.execute(() -> { try { serve(socket); } finally { deadline.cancel(false); } }); }
                        catch (RejectedExecutionException busy) { deadline.cancel(false); throw busy; }
                    } catch (RejectedExecutionException busy) { sockets.remove(socket); socket.close(); }
                } catch (IOException stopped) { if (!closed) close(); }
            }
        }, "companion-accept").start();

    }

    private void serve(SSLSocket socket) {
        try (socket) {
            socket.startHandshake();
            InputStream in = socket.getInputStream();
            ByteArrayOutputStream header = new ByteArrayOutputStream();
            int state = 0;
            while (state < 4) {
                int c = in.read();
                if (c < 0 || header.size() >= 8192) throw new IOException();
                header.write(c);
                state = c == (state % 2 == 0 ? '\r' : '\n') ? state + 1 : c == '\r' ? 1 : 0;
            }
            String[] lines = header.toString(StandardCharsets.US_ASCII.name()).split("\r\n");
            String[] request = lines[0].split(" ");
            if (request.length != 3 || !"HTTP/1.1".equals(request[2])) throw new IOException();
            Map<String, String> headers = new HashMap<>();
            for (int i = 1; i < lines.length; i++) {
                int colon = lines[i].indexOf(':');
                if (colon <= 0) throw new IOException();
                String name = lines[i].substring(0, colon).toLowerCase(Locale.ROOT);
                if (!name.matches("[a-z0-9-]+") || headers.put(name, lines[i].substring(colon + 1).trim()) != null) throw new IOException();
            }
            if (closed || SystemClock.elapsedRealtime() >= expires || !constant("Bearer " + token, headers.get("authorization"))) {
                reply(socket, 401, "application/json", "{}".getBytes(StandardCharsets.UTF_8), null); return;
            }
            if (headers.containsKey("transfer-encoding") || headers.containsKey("expect")) throw new IOException();
            if ("GET".equals(request[0]) && request[1].startsWith("/media/")) {
                if (headers.containsKey("content-length") && !"0".equals(headers.get("content-length"))) throw new IOException();
                serveMedia(socket, request[1], headers); return;
            }
            if (!"POST".equals(request[0]) || !"/rpc".equals(request[1]) || !"application/json".equals(headers.get("content-type"))) {
                reply(socket, 404, "application/json", "{}".getBytes(StandardCharsets.UTF_8), null); return;
            }
            String lengthText = headers.getOrDefault("content-length", "");
            if (!lengthText.matches("[0-9]{1,5}")) throw new IOException();
            int length = Integer.parseInt(lengthText);
            if (length < 2 || length > 16_384) throw new IOException();
            byte[] body = new byte[length]; new DataInputStream(in).readFully(body);
            JSONObject result;
            try { JsonLimits.check(body); result = rpc(new JSONObject(new String(body, StandardCharsets.UTF_8))); }
            catch (Exception rejected) { reply(socket, 400, "application/json", "{\"error\":\"request-rejected\"}".getBytes(StandardCharsets.UTF_8), null); return; }
            reply(socket, 200, "application/json", result.toString().getBytes(StandardCharsets.UTF_8), null);
        } catch (Exception ignored) {
            // Never log credential, request, exception text or source data.
        } finally { sockets.remove(socket); }
    }

    private synchronized JSONObject rpc(JSONObject request) throws Exception {
        if (closed) throw new IOException();
        String method = request.getString("method");
        if ("capabilities".equals(method)) return new JSONObject().put("protocol", 1).put("profile", PROFILE)
            .put("apiLevel", Build.VERSION.SDK_INT).put("abis", new JSONArray(Arrays.asList(Build.SUPPORTED_ABIS)))
            .put("externalCode", false).put("webview", false).put("jni", false).put("hls", false).put("range", true);
        if (!SOURCE.equals(request.getString("sourceId")) || !PROFILE.equals(request.getString("profile"))) throw new IOException();
        String revision = request.getString("configRevision");
        if (!revision.matches("[A-Za-z0-9._-]{1,64}")) throw new IOException();
        if ("init".equals(method)) {
            revokeSession();
            Session created = new Session(revision);
            session = created;
            created.expiry = deadlines.schedule(() -> {
                synchronized (this) { if (session == created) revokeSession(); }
            }, 120_000, TimeUnit.MILLISECONDS);
            return new JSONObject().put("sessionId", created.id).put("expiresInMs", 120_000);
        }
        Session active = session;
        if (active == null || SystemClock.elapsedRealtime() >= active.expires || !active.revision.equals(revision)
            || !constant(active.id, request.optString("sessionId"))) throw new IOException();
        JSONObject item = new JSONObject().put("id", "tone").put("name", "Android built-in 440 Hz tone");
        switch (method) {
            case "home": case "category": case "search":
                return new JSONObject().put("items", new JSONArray().put(item));
            case "detail":
                return new JSONObject().put("item", item).put("episodes", new JSONArray().put(new JSONObject().put("id", "tone").put("flag", "fixture")));
            case "play":
                return new JSONObject().put("resourceHandle", active.handle).put("mimeType", "audio/wav")
                    .put("length", media.length).put("sha256", hex(MessageDigest.getInstance("SHA-256").digest(media)));
            case "destroy": revokeSession(); return new JSONObject().put("destroyed", true);
            default: throw new IOException();
        }
    }

    private void serveMedia(Socket socket, String path, Map<String, String> headers) throws IOException {
        Session active;
        synchronized (this) {
            active = session;
            if (closed || active == null || SystemClock.elapsedRealtime() >= active.expires
                || !constant(active.id, headers.get("x-companion-session")) || !path.equals("/media/" + active.handle)) active = null;
            // Register under the same lock as validation. Revocation closes registered
            // sockets before returning, including a stream waiting to write its response.
            if (active != null && !active.resources.register(socket)) active = null;
        }
        if (active == null) {
            reply(socket, 404, "application/json", "{}".getBytes(StandardCharsets.UTF_8), null); return;
        }
        try {
            String range = headers.get("range");
            int start = 0, end = media.length - 1;
            if (range != null) {
                if (!range.matches("bytes=[0-9]{1,9}-[0-9]{0,9}")) { rangeRejected(socket); return; }
                String[] offsets = range.substring(6).split("-", -1);
                start = Integer.parseInt(offsets[0]);
                if (!offsets[1].isEmpty()) end = Math.min(end, Integer.parseInt(offsets[1]));
                if (start > end || start >= media.length) { rangeRejected(socket); return; }
            }
            reply(socket, range == null ? 200 : 206, "audio/wav", Arrays.copyOfRange(media, start, end + 1),
                range == null ? "Accept-Ranges: bytes\r\n" : "Accept-Ranges: bytes\r\nContent-Range: bytes " + start + "-" + end + "/" + media.length + "\r\n");
        } finally { active.resources.release(socket); }
    }

    private synchronized void revokeSession() {
        if (session == null) return;
        if (session.expiry != null) session.expiry.cancel(false);
        session.resources.revoke(); session = null;
    }

    private void rangeRejected(Socket socket) throws IOException {
        reply(socket, 416, "application/json", "{}".getBytes(StandardCharsets.UTF_8), "Content-Range: bytes */" + media.length + "\r\n");
    }
    private static void reply(Socket socket, int status, String type, byte[] body, String extra) throws IOException {
        OutputStream out = socket.getOutputStream();
        out.write(("HTTP/1.1 " + status + " Result\r\nContent-Type: " + type + "\r\nContent-Length: " + body.length
            + "\r\nConnection: close\r\nCache-Control: no-store\r\n" + (extra == null ? "" : extra) + "\r\n").getBytes(StandardCharsets.US_ASCII));
        out.write(body); out.flush();
    }
    private static boolean constant(String expected, String actual) {
        return actual != null && MessageDigest.isEqual(expected.getBytes(StandardCharsets.UTF_8), actual.getBytes(StandardCharsets.UTF_8));
    }
    private static String random() { byte[] data = new byte[32]; new SecureRandom().nextBytes(data); return Base64.getUrlEncoder().withoutPadding().encodeToString(data); }
    private static String hex(byte[] data) { StringBuilder result = new StringBuilder(); for (byte b : data) result.append(String.format(Locale.ROOT, "%02x", b & 255)); return result.toString(); }
    private static byte[] tone() {
        int samples = 16_000, size = samples * 2;
        ByteBuffer b = ByteBuffer.allocate(44 + size).order(ByteOrder.LITTLE_ENDIAN);
        b.put("RIFF".getBytes(StandardCharsets.US_ASCII)).putInt(36 + size).put("WAVEfmt ".getBytes(StandardCharsets.US_ASCII));
        b.putInt(16).putShort((short) 1).putShort((short) 1).putInt(8000).putInt(16000).putShort((short) 2).putShort((short) 16);
        b.put("data".getBytes(StandardCharsets.US_ASCII)).putInt(size);
        for (int i = 0; i < samples; i++) b.putShort((short) (Math.sin(2 * Math.PI * 440 * i / 8000) * 8192));
        return b.array();
    }
    private void deleteKey() { try { KeyStore store = KeyStore.getInstance("AndroidKeyStore"); store.load(null); store.deleteEntry(alias); } catch (Exception ignored) { } }
    @Override public synchronized void close() {
        if (closed) return;
        closed = true; revokeSession();
        try { listener.close(); } catch (IOException ignored) { }
        for (Socket socket : sockets) try { socket.close(); } catch (IOException ignored) { }
        sockets.clear(); workers.shutdownNow(); deadlines.shutdownNow(); deleteKey();
    }
}
