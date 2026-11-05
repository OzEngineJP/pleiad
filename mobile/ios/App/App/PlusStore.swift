// Pleiad Plus の保管（docs/plus.md「iOS」。Android の PlusStore.kt）。
//   UserDefaults "plus.config"  — 最後に取れた /v1/auth/config（秘密は無いので平文）
//   UserDefaults "plus.entrance" — visibility: optin の間の入口の印（pleiad://plus/enable で立つ。同期しない）
//   Keychain "plus-pending"     — 進行中のログインの verifier/state（ASWebAuthenticationSession を跨ぐ）
//   Keychain "plus-session"     — セッション記録。ID トークンは残さず refresh だけ残す
import Foundation
import PleiadRemote

final class PlusStore {
    private static let configKey = "plus.config"
    private static let entranceKey = "plus.entrance"
    private let defaults = UserDefaults.standard
    private let pendingVault = KeychainVault(account: "plus-pending")
    private let sessionVault = KeychainVault(account: "plus-session")

    func config() -> PlusConfig? { defaults.string(forKey: Self.configKey).flatMap(PlusConfig.parse) }
    func saveConfig(_ c: PlusConfig) { defaults.set(c.json.serialized, forKey: Self.configKey) }

    func entrance() -> Bool { defaults.bool(forKey: Self.entranceKey) }
    func saveEntrance(_ on: Bool) { defaults.set(on, forKey: Self.entranceKey) }

    private func seal(_ vault: KeychainVault, _ j: JSON) { try? vault.save(Bytes(j.serialized.utf8)) }
    private func unseal(_ vault: KeychainVault) -> JSON? {
        // load() は throws -> Bytes?。try? が二重の Optional を 1 つに畳むので、ここで 1 回だけ外す。
        guard let data = try? vault.load(), !data.isEmpty else { return nil }
        return try? JSON.parse(data)
    }

    func pending() -> PlusAuth.Pending? { unseal(pendingVault).flatMap(PlusAuth.Pending.from) }
    func savePending(_ p: PlusAuth.Pending) { seal(pendingVault, p.json) }
    func clearPending() { try? pendingVault.delete() }

    func sessionStore() -> PlusSession.SessionStore {
        struct KeychainStore: PlusSession.SessionStore {
            let store: PlusStore
            func load() -> SessionRecord? { store.unseal(store.sessionVault).flatMap(SessionRecord.from) }
            func save(_ r: SessionRecord) { store.seal(store.sessionVault, r.json) }
            func clear() { try? store.sessionVault.delete() }
        }
        return KeychainStore(store: self)
    }
}
