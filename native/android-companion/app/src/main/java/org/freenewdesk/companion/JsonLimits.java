package org.freenewdesk.companion;

import java.nio.charset.StandardCharsets;
import java.util.HashSet;
import java.util.Set;

/** Strict flat RPC grammar before Android's permissive, recursive JSONTokener.
 * Only known literal keys with JSON string values are accepted. No nesting,
 * unquoted keys, comments, single quotes, duplicate keys or alternate syntax.
 */
final class JsonLimits {
    private final byte[] input;
    private int cursor;
    private JsonLimits(byte[] input) { this.input = input; }
    static void check(byte[] input) {
        if (input.length < 2 || input.length > 16_384) throw new IllegalArgumentException();
        new JsonLimits(input).object();
    }
    private void object() {
        space(); expect('{'); space();
        Set<String> seen = new HashSet<>();
        if (peek() != '}') while (true) {
            int start = cursor + 1;
            string();
            String key = new String(input, start, cursor - start - 1, StandardCharsets.US_ASCII);
            if (!(key.equals("method") || key.equals("sourceId") || key.equals("profile")
                || key.equals("configRevision") || key.equals("sessionId")) || !seen.add(key)) reject();
            space(); expect(':'); space(); string(); space();
            if (peek() != ',') break;
            cursor++; space();
        }
        expect('}'); space();
        if (cursor != input.length) reject();
    }
    private void string() {
        expect('"');
        while (cursor < input.length) {
            int c = input[cursor++] & 255;
            if (c == '"') return;
            if (c < 0x20) reject();
            if (c == '\\') {
                if (cursor == input.length) reject();
                int escape = input[cursor++] & 255;
                if (escape == 'u') {
                    for (int i = 0; i < 4; i++) {
                        if (cursor == input.length) reject();
                        int hex = input[cursor++] & 255;
                        if (!(hex >= '0' && hex <= '9' || hex >= 'a' && hex <= 'f' || hex >= 'A' && hex <= 'F')) reject();
                    }
                } else if (escape != '"' && escape != '\\' && escape != '/' && escape != 'b'
                    && escape != 'f' && escape != 'n' && escape != 'r' && escape != 't') reject();
            }
        }
        reject();
    }
    private void space() { while (cursor < input.length && (input[cursor] == ' ' || input[cursor] == '\t' || input[cursor] == '\r' || input[cursor] == '\n')) cursor++; }
    private int peek() { return cursor < input.length ? input[cursor] & 255 : -1; }
    private void expect(int expected) { if (peek() != expected) reject(); cursor++; }
    private static void reject() { throw new IllegalArgumentException(); }
}
