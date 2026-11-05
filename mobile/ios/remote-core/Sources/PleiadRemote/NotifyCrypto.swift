// Decrypts the host's notice (core/notify/crypto.mjs), docs/remote.md §11-5. Swift port of NotifyCrypto.kt
// (CryptoKit; the notification extension links this file).
//
//   blob = base64url( nonce(12) || AES-256-GCM(plain 512 bytes) || tag(16) )
//   plain = u16(BE: JSON length) || JSON (UTF-8) || zero padding
//   AAD = "pleiad-notify/1\n" + hostId + "\n" + deviceId
//
// The key is the device's own 32-byte notification key (made here, registered with the host over the E2E channel).

import Foundation
#if canImport(CryptoKit)
import CryptoKit
#else
import Crypto
#endif

public enum NotifyCrypto {
    public static let PLAIN_BYTES = 512
    public static let NONCE_BYTES = 12
    public static let TAG_BYTES = 16
    public static let BLOB_BYTES = NONCE_BYTES + PLAIN_BYTES + TAG_BYTES
    public static let KEY_BYTES = 32

    public static func generateKey() -> Bytes { randomBytes(KEY_BYTES) }

    public static func encodeKey(_ key: Bytes) -> String { Base64URL.encode(key) }

    static func aad(_ hostId: String, _ deviceId: String) -> Bytes {
        Bytes("pleiad-notify/1\n\(hostId)\n\(deviceId)".utf8)
    }

    /// The decrypted notice, or nil when it does not open (wrong key / host / device, tampered, malformed).
    public static func open(key: Bytes, hostId: String, deviceId: String, blob: String) -> PushNotice? {
        do {
            guard let raw = Base64URL.decode(blob), raw.count == BLOB_BYTES, key.count == KEY_BYTES else { return nil }
            let box = try AES.GCM.SealedBox(nonce: AES.GCM.Nonce(data: Data(raw[0..<NONCE_BYTES])),
                                            ciphertext: Data(raw[NONCE_BYTES..<(BLOB_BYTES - TAG_BYTES)]),
                                            tag: Data(raw[(BLOB_BYTES - TAG_BYTES)...]))
            let plain = Bytes(try AES.GCM.open(box, using: SymmetricKey(data: key), authenticating: aad(hostId, deviceId)))
            let len = (Int(plain[0]) << 8) | Int(plain[1])
            guard len >= 2, len <= PLAIN_BYTES - 2 else { return nil }
            return PushNotice.from(try JSON.parse(Bytes(plain[2..<(2 + len)])))
        } catch { return nil }
    }

    /// For tests (the host seals; a device never does). Writes the keys in core/notify/crypto.mjs normalizeNotice's
    /// order, so a shared vector (tests/remote/notify-vectors.json) seals back to the same blob.
    static func seal(key: Bytes, hostId: String, deviceId: String, notice o: JSON, nonce: Bytes? = nil) throws -> String {
        var body = "{"
        var first = true
        for k in ["v", "seq", "at", "kind", "hostId", "host", "session", "title", "id", "cancel"] {
            guard let v = o[k], v != .null else { continue }
            if !first { body += "," }
            first = false
            body += JSON.string(k).serialized + ":" + v.serialized
        }
        body += "}"
        let text = Bytes(body.utf8)
        precondition(text.count <= PLAIN_BYTES - 2)
        var plain = Bytes(repeating: 0, count: PLAIN_BYTES)
        plain[0] = UInt8(text.count >> 8)
        plain[1] = UInt8(text.count & 0xff)
        plain.replaceSubrange(2..<(2 + text.count), with: text)
        let n = nonce ?? randomBytes(NONCE_BYTES)
        let box = try AES.GCM.seal(Data(plain), using: SymmetricKey(data: key), nonce: AES.GCM.Nonce(data: Data(n)),
                                   authenticating: aad(hostId, deviceId))
        return Base64URL.encode(n + Bytes(box.ciphertext) + Bytes(box.tag))
    }
}
