package org.freenewdesk.companion;

import java.io.IOException;
import java.net.Socket;
import java.util.HashSet;
import java.util.Set;

/** Revocation closes in-flight streams, and stale snapshots cannot register new ones. */
final class ResourceLease {
    private boolean revoked;
    private final Set<Socket> sockets = new HashSet<>();
    synchronized boolean register(Socket socket) {
        if (revoked) return false;
        sockets.add(socket); return true;
    }
    synchronized void release(Socket socket) { sockets.remove(socket); }
    synchronized void revoke() {
        revoked = true;
        for (Socket socket : sockets) try { socket.close(); } catch (IOException ignored) { }
        sockets.clear();
    }
}
