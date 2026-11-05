// 端末の静的鍵と中継用トークンを、同期・移行しない Keychain の 1 項目に保管する（ADR 0174）。
// 通知の鍵だけは共有アクセスグループの項目に置き、通知拡張（NotifyService）も同じものを読む（ADR 0086 iOS）。
import Foundation
import Security
import PleiadRemote
final class KeychainVault: SecretVault {
    static let service = "dev.pleiad.app.remote"
    private let account: String
    private let accessGroup: String?

    init(account: String = "secrets", accessGroup: String? = nil) {
        self.account = account
        self.accessGroup = accessGroup
    }

    let protected = true

    private var query: [String: Any] {
        var q: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
                              kSecAttrService as String: KeychainVault.service,
                              kSecAttrAccount as String: account,
                              kSecAttrSynchronizable as String: kCFBooleanFalse as Any]
        if let accessGroup { q[kSecAttrAccessGroup as String] = accessGroup }
        return q
    }

    /// このアプリが黙って届くアクセスグループ（entitlements の先頭 = "$(AppIdentifierPrefix)dev.pleiad.app"）。
    /// いったん項目を書いて属性を読む。nil はエンタイトルメントが無いか読めないとき。
    static func defaultAccessGroup() -> String? {
        let probe = "pleiad-group-probe"
        let base: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
                                 kSecAttrService as String: service,
                                 kSecAttrAccount as String: probe,
                                 kSecAttrSynchronizable as String: kCFBooleanFalse as Any]
        var add = base
        add[kSecValueData as String] = Data([0])
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let st = SecItemAdd(add as CFDictionary, nil)
        guard st == errSecSuccess || st == errSecDuplicateItem else { return nil }
        var read = base
        read[kSecReturnAttributes as String] = true
        var out: CFTypeRef?
        let found = SecItemCopyMatching(read as CFDictionary, &out)
        SecItemDelete(base as CFDictionary)
        guard found == errSecSuccess, let attrs = out as? [String: Any] else { return nil }
        return attrs[kSecAttrAccessGroup as String] as? String
    }

    /// 共有グループの完全名（"$(AppIdentifierPrefix)dev.pleiad.app.shared"）。自分の既定グループに尾を足すだけ。
    static func sharedAccessGroup() -> String? { defaultAccessGroup().map { $0 + ".shared" } }

    func load() throws -> Bytes? {
        var q = query
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        let st = SecItemCopyMatching(q as CFDictionary, &out)
        if st == errSecItemNotFound { return nil }
        guard st == errSecSuccess, let data = out as? Data else { throw VaultError("keychain read \(st)") }
        return Bytes(data)
    }

    func save(_ data: Bytes) throws {
        let attrs: [String: Any] = [kSecValueData as String: Data(data),
                                    kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        var st = SecItemUpdate(query as CFDictionary, attrs as CFDictionary)
        if st == errSecItemNotFound {
            var add = query
            for (k, v) in attrs { add[k] = v }
            st = SecItemAdd(add as CFDictionary, nil)
        }
        guard st == errSecSuccess else { throw VaultError("keychain write \(st)") }
    }

    func delete() throws {
        let st = SecItemDelete(query as CFDictionary)
        guard st == errSecSuccess || st == errSecItemNotFound else { throw VaultError("keychain delete \(st)") }
    }
}
