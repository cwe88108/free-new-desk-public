package org.freenewdesk.companion;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.function.BiConsumer;
import java.util.function.LongConsumer;

/** Serial creation avoids competing binds. Epochs fence callbacks after stop/restart. */
final class SerialLifecycle<T extends AutoCloseable> implements AutoCloseable {
    interface Factory<T> { T create() throws Exception; }
    private final ExecutorService startup = Executors.newSingleThreadExecutor();
    private long generation;
    private boolean disposed;
    private T active;

    synchronized void start(Factory<T> factory, BiConsumer<T, Long> ready, LongConsumer failed) {
        if (disposed) return;
        stop();
        final long expected = generation;
        startup.execute(() -> {
            synchronized (this) { if (!isCurrent(expected)) return; }
            T candidate = null;
            try {
                candidate = factory.create();
                synchronized (this) {
                    if (!isCurrent(expected)) { release(candidate); return; }
                    active = candidate;
                    ready.accept(candidate, expected);
                }
            } catch (Exception error) {
                synchronized (this) {
                    release(candidate);
                    if (active == candidate) active = null;
                    if (isCurrent(expected)) failed.accept(expected);
                }
            }
        });
    }
    synchronized boolean isCurrent(long expected) { return !disposed && expected == generation; }
    synchronized void stop() { generation++; release(active); active = null; }
    @Override public synchronized void close() { stop(); disposed = true; startup.shutdown(); }
    private static void release(AutoCloseable value) { if (value != null) try { value.close(); } catch (Exception ignored) { } }
}
