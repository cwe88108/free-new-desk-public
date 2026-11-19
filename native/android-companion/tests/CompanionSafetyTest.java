package org.freenewdesk.companion;

import java.io.IOException;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;

/** JVM helper tests; no Android classes, ART or APK claims. */
public final class CompanionSafetyTest {
    private static void check(boolean condition, String message) { if (!condition) throw new AssertionError(message); }
    private static void json(String input) { JsonLimits.check(input.getBytes(StandardCharsets.UTF_8)); }
    private static void rejected(String input) {
        try { json(input); throw new AssertionError("expected JSON bound rejection"); }
        catch (IllegalArgumentException expected) { }
    }
    public static void main(String[] args) throws Exception {
        json("{\"method\":\"home\",\"sessionId\":\"abc\"}");
        json("{\"method\":\"[[[\\\"{}\\\\\"}");
        rejected("[".repeat(32) + "0" + "]".repeat(32));
        rejected("{\"method\":" + "[".repeat(6000) + "0" + "]".repeat(6000) + "}");
        rejected("{x:'\"',y:" + "[".repeat(6000) + "0" + "]".repeat(6000) + ",z:'\"'}");
        rejected("{\"method\":/*\"*/" + "[".repeat(6000) + "0" + "]".repeat(6000) + "/*\"*/}");
        rejected("{\"method\":\"" + "x".repeat(16_384) + "\"}");
        rejected("{\"method\":\"unfinished}");
        rejected("{\"method\":'home'}");
        rejected("{\"method\":\"home\",}");
        rejected("{\"method\":\"home\",\"method\":\"play\"}");
        rejected("{\"unknown\":\"home\"}");
        rejected("{\"method\":null}");
        rejected("{x:#\"\n" + "[".repeat(6000) + "0" + "]".repeat(6000) + ",z:#\"\n0}");
        rejected("{\"method\":\"bad\\q\"}");
        rejected("{]");
        System.out.println("PASS strict flat JSON grammar, quoted escapes and lax-parser bypass rejection");
        int failures = 0;
        try { leaseRevocation(); } catch (Exception | AssertionError error) { System.err.println("FAIL lease revocation: " + error); failures++; }
        try { repeatedStart(); } catch (Exception | AssertionError error) { System.err.println("FAIL repeated Start: " + error); failures++; }
        try { stoppedStart(); } catch (Exception | AssertionError error) { System.err.println("FAIL stopped Start: " + error); failures++; }
        if (failures > 0) throw new AssertionError(failures + " companion safety test group(s) failed");
    }

    private static void leaseRevocation() throws Exception {
        try (ServerSocket listener = new ServerSocket(0); Socket writer = new Socket("127.0.0.1", listener.getLocalPort()); Socket reader = listener.accept()) {
            ResourceLease lease = new ResourceLease();
            check(lease.register(writer), "register live lease");
            lease.revoke();
            check(writer.isClosed(), "revoke must close in-flight socket before returning");
            check(!lease.register(reader), "stale lease snapshot cannot register a response");
            try { writer.getOutputStream().write(1); throw new AssertionError("revoked stream wrote"); }
            catch (IOException expected) { }
            lease.release(writer); lease.revoke();
        }
        System.out.println("PASS resource revocation and stale-snapshot denial");
    }
    private static final class Bound implements AutoCloseable {
        final ServerSocket socket;
        final CountDownLatch closed = new CountDownLatch(1);
        Bound(int port) throws IOException { socket = new ServerSocket(port); }
        public void close() throws IOException { socket.close(); closed.countDown(); }
    }
    private static void await(CountDownLatch latch) throws Exception { check(latch.await(5, TimeUnit.SECONDS), "test deadline"); }
    private static void repeatedStart() throws Exception {
        CountDownLatch entered = new CountDownLatch(1), proceed = new CountDownLatch(1), ready = new CountDownLatch(1);
        AtomicInteger callbacks = new AtomicInteger(), failures = new AtomicInteger(), port = new AtomicInteger();
        Bound[] first = new Bound[1], second = new Bound[1];
        try (SerialLifecycle<Bound> lifecycle = new SerialLifecycle<>()) {
            lifecycle.start(() -> {
                first[0] = new Bound(0); port.set(first[0].socket.getLocalPort()); entered.countDown(); await(proceed); return first[0];
            }, (resource, epoch) -> callbacks.incrementAndGet(), epoch -> failures.incrementAndGet());
            await(entered);
            lifecycle.start(() -> { second[0] = new Bound(port.get()); return second[0]; },
                (resource, epoch) -> { callbacks.incrementAndGet(); ready.countDown(); }, epoch -> { failures.incrementAndGet(); ready.countDown(); });
            proceed.countDown(); await(ready);
            check(first[0].socket.isClosed(), "superseded listener closed before replacement binds");
            check(failures.get() == 0 && callbacks.get() == 1, "only latest Start publishes, no port conflict");
            lifecycle.stop(); check(second[0].socket.isClosed(), "Stop closes current listener");
        }
        System.out.println("PASS concurrent Start serialized on the same real port");
    }
    private static void stoppedStart() throws Exception {
        CountDownLatch entered = new CountDownLatch(1), proceed = new CountDownLatch(1);
        Bound[] candidate = new Bound[1]; AtomicInteger callbacks = new AtomicInteger();
        try (SerialLifecycle<Bound> lifecycle = new SerialLifecycle<>()) {
            lifecycle.start(() -> { candidate[0] = new Bound(0); entered.countDown(); await(proceed); return candidate[0]; },
                (resource, epoch) -> callbacks.incrementAndGet(), epoch -> callbacks.incrementAndGet());
            await(entered); lifecycle.stop(); proceed.countDown(); await(candidate[0].closed);
            check(callbacks.get() == 0, "Stop while creating must not publish old listener");
        }
        System.out.println("PASS Stop fences startup and late callbacks");
    }
}
