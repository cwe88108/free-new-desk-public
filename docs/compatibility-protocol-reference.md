# TVBox configuration protocol reference

Free New Desk V1.4.7 implements encrypted configuration handling as protocol compatibility rather than key-guessing.

Observed public TVBox-compatible behavior:

- `random**base64`: marker followed by Base64 configuration text.
- Hex `$#key#$...<13-byte IV>` wrapper: AES-128-CBC with the embedded key and IV right-padded with ASCII `0` to 16 bytes.
- URL `;pk;<key>` form: the URL before `;pk;` is fetched and its hex response is decrypted with AES-128-ECB using the explicit key right-padded with ASCII `0` to 16 bytes.

Unknown dollar-shell formats are detected and rejected with `SRC_CONFIG_DECRYPT_FAIL`. V1.4.7 intentionally does not try MD5/SHA256/raw-key variants in sequence.

Reference implementations used only to establish wire/protocol behavior include public TVBoxOS-compatible `ApiConfig`/`AES` implementations; no third-party source files are bundled into Free New Desk.
