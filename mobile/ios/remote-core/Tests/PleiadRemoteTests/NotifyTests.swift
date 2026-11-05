import Foundation
import XCTest
@testable import PleiadRemote

/// NotifyCrypto / NotifyPlanner / NotifySettings / the store's notify.json — Swift port of the Android NotifyTest.kt
/// halves that apply to iOS (crypto + planner; the line and presenter are Android-only). The sealed examples come from
/// tests/remote/notify-vectors.json, which Node (tests/unit/push-notify.mjs) and Kotlin also read.
final class NotifyCryptoTests: XCTestCase {
    private func vectors() throws -> JSON {
        try JSON.parse(Bytes(try Data(contentsOf: repoRoot().appendingPathComponent("tests/remote/notify-vectors.json"))))
    }

    func testSharedVectors() throws {
        let vec = try vectors()
        let key = hex(vec["key"]!.string!)
        let hostId = vec["hostId"]!.string!
        let deviceId = vec["deviceId"]!.string!
        guard let cases = vec["cases"]?.array, cases.count >= 5 else { return XCTFail("vectors") }
        // Node (the host) sealed these: every one must decrypt to exactly the notice in the file
        for c in cases {
            let blob = c["blob"]!.string!
            XCTAssertEqual(blob.count * 6 / 8, NotifyCrypto.BLOB_BYTES, c["name"]?.string ?? "?")
            XCTAssertEqual(try NotifyCrypto.open(key: key, hostId: hostId, deviceId: deviceId, blob: blob),
                           PushNotice.from(c["notice"]!), c["name"]?.string ?? "?")
            // Sealing the notice again with the vector's nonce reproduces the same blob
            XCTAssertEqual(try NotifyCrypto.seal(key: key, hostId: hostId, deviceId: deviceId, notice: c["notice"]!,
                                                 nonce: hex(c["nonce"]!.string!)),
                           blob, "seal \(c["name"]?.string ?? "?")")
        }
        // Wrong key / host / device, tampered ciphertext, malformed / short / empty blobs all fail to open
        let blob = cases[0]["blob"]!.string!
        var wrongKey = key; wrongKey[0] ^= 1
        XCTAssertNil(NotifyCrypto.open(key: wrongKey, hostId: hostId, deviceId: deviceId, blob: blob), "wrong key")
        XCTAssertNil(NotifyCrypto.open(key: key, hostId: "other-host", deviceId: deviceId, blob: blob), "wrong host")
        XCTAssertNil(NotifyCrypto.open(key: key, hostId: hostId, deviceId: "other-device", blob: blob), "wrong device")
        var tampered = Base64URL.decode(blob)!; tampered[20] ^= 1
        XCTAssertNil(NotifyCrypto.open(key: key, hostId: hostId, deviceId: deviceId, blob: Base64URL.encode(tampered)),
                     "tampered")
        XCTAssertNil(NotifyCrypto.open(key: key, hostId: hostId, deviceId: deviceId, blob: ""), "empty")
        XCTAssertNil(NotifyCrypto.open(key: key, hostId: hostId, deviceId: deviceId, blob: "AAAA"), "short")
        XCTAssertNil(NotifyCrypto.open(key: key, hostId: hostId, deviceId: deviceId,
                                       blob: Base64URL.encode(Bytes(repeating: 0, count: NotifyCrypto.BLOB_BYTES))),
                     "zeros")
        XCTAssertNil(NotifyCrypto.open(key: key, hostId: hostId, deviceId: deviceId, blob: "not!base64"), "malformed")
        XCTAssertNil(NotifyCrypto.open(key: Bytes(repeating: 0, count: 16), hostId: hostId, deviceId: deviceId, blob: blob),
                     "bad key length")
    }

    func testRoundTrip() throws {
        let key = NotifyCrypto.generateKey()
        XCTAssertEqual(key.count, NotifyCrypto.KEY_BYTES)
        XCTAssertEqual(Base64URL.decode(NotifyCrypto.encodeKey(key)), key)
        let notice: JSON = ["v": 1, "seq": 42, "at": 99, "kind": "question", "hostId": "h1", "host": "会社のPC",
                            "session": "s1", "title": "見積書を確認して", "id": "q1"]
        let blob = try NotifyCrypto.seal(key: key, hostId: "h1", deviceId: "d1", notice: notice)
        let n = try XCTUnwrap(NotifyCrypto.open(key: key, hostId: "h1", deviceId: "d1", blob: blob))
        XCTAssertEqual(n.kind, NoticeKind.QUESTION)
        XCTAssertEqual(n.title, "見積書を確認して")   // a Japanese title comes through intact
        XCTAssertEqual(n.id, "q1")
        XCTAssertEqual(n.seq, 42)
        XCTAssertNil(n.cancel)
        // Optional fields absent
        let bare = try XCTUnwrap(NotifyCrypto.open(key: key, hostId: "h1", deviceId: "d1",
            blob: NotifyCrypto.seal(key: key, hostId: "h1", deviceId: "d1",
                                    notice: ["v": 1, "seq": 43, "at": 1, "kind": "done", "hostId": "h1",
                                             "host": "x", "session": "s", "title": "t"])))
        XCTAssertNil(bare.id)
        // Notices that are not v=1 / a known kind / seq>0 are dropped
        XCTAssertNil(PushNotice.from(["v": 2, "seq": 1, "kind": "done"]))
        XCTAssertNil(PushNotice.from(["v": 1, "seq": 0, "kind": "done"]))
        XCTAssertNil(PushNotice.from(["v": 1, "seq": 1, "kind": "nope"]))
    }

    func testSettingsShape() {
        // core/notify/policy.mjs DEFAULT_DEVICE_SETTINGS and the register args' shape
        XCTAssertEqual(NotifySettings().json, ["enabled": false, "reply": true, "failed": true, "done": true,
                                               "lockNames": false, "skipPc": true])
        XCTAssertEqual(NotifySettings(enabled: true, reply: false, failed: false, done: false,
                                      lockNames: true, skipPc: false).json,
                       ["enabled": true, "reply": false, "failed": false, "done": false,
                        "lockNames": true, "skipPc": false] as JSON)
        // Unknown fields are dropped, non-bools ignored, missing fields keep their defaults
        let s = NotifySettings.from(["enabled": true, "reply": "yes", "extra": 1])
        XCTAssertEqual(s, NotifySettings(enabled: true))
        XCTAssertEqual(NotifySettings.from(nil), NotifySettings())
    }
}

final class NotifyStoreTests: XCTestCase {
    private func dir() throws -> URL {
        let d = FileManager.default.temporaryDirectory.appendingPathComponent("pleiad-notify-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        return d
    }

    func testNotifyJson() throws {
        let store = try DeviceStore(dir: dir())
        XCTAssertEqual(store.notifySettings(), NotifySettings())          // defaults, no file
        XCTAssertFalse(store.notifyBandDismissed())
        try store.saveNotifySettings(NotifySettings(enabled: true, reply: false, failed: true, done: true,
                                                    lockNames: true, skipPc: true))
        try store.setNotifyBandDismissed(true)
        let again = try DeviceStore(dir: store.dir)
        let s = again.notifySettings()
        XCTAssertTrue(s.enabled && !s.reply && s.failed && s.done && s.lockNames && s.skipPc)
        XCTAssertTrue(again.notifyBandDismissed())
        // notify.json holds settings only — never the key
        let text = String(data: try Data(contentsOf: store.dir.appendingPathComponent("notify.json")), encoding: .utf8)!
        XCTAssertTrue(text.contains("\"lockNames\"") && !text.contains("notifyKey") && !text.contains("secret"))
        // The key is stable, 32 bytes, and lives in the secrets blob (no notifyVault)
        let k1 = try store.notifyKey()
        XCTAssertEqual(k1.count, NotifyCrypto.KEY_BYTES)
        XCTAssertEqual(try again.notifyKey(), k1)
    }

    func testNotifyKeyInOwnVault() throws {
        let d = try dir()
        let shared = FileVault(file: d.appendingPathComponent("shared-key.bin"))
        let store = try DeviceStore(dir: d, notifyVault: shared)
        let k1 = try store.notifyKey()
        XCTAssertEqual(k1.count, NotifyCrypto.KEY_BYTES)
        // A second store over the same shared item reads the same key (the app and the notification extension)
        let again = try DeviceStore(dir: d, notifyVault: shared)
        XCTAssertEqual(try again.notifyKey(), k1)
        // The secrets blob does not carry it
        let secrets = (try? String(data: Data(contentsOf: d.appendingPathComponent("secrets.json")), encoding: .utf8)) ?? ""
        XCTAssertFalse(secrets.contains("notifyKey"))
    }
}

final class NotifyPlannerTests: XCTestCase {
    private var seq: Int64 = 0
    private func notice(_ kind: String, _ session: String, _ over: [String: JSON] = [:]) -> PushNotice {
        seq += 1
        var o: [String: JSON] = ["v": 1, "seq": .int(seq), "at": .int(seq), "kind": .string(kind), "hostId": "h1",
                                 "host": "main-pc", "session": .string(session), "title": .string("t-\(session)")]
        for (k, v) in over { o[k] = v }
        return PushNotice.from(.object(o))!
    }
    private let on = NotifySettings(enabled: true)
    private func keys(_ acts: [NotifyAction]) -> [String] { acts.map { $0.key } }

    func testBasicPostAndCancel() {
        seq = 0; let p = NotifyPlanner()
        let acts = p.onNotice(notice(NoticeKind.APPROVAL, "s1", ["id": "a1"]), on)
        XCTAssertEqual(acts, [.post(.init(key: "h1|s1", kind: NoticeKind.APPROVAL, hostId: "h1", host: "main-pc",
                                        session: "s1", title: "t-s1", at: 1, attention: true))])
        // A second pending item in the same conversation re-counts in place
        let again = p.onNotice(notice(NoticeKind.QUESTION, "s1", ["id": "q1"]), on)
        XCTAssertEqual(again.count, 1)
        if case .post(let post) = again[0] { XCTAssertEqual(post.pending, 2) } else { XCTFail() }
        // Replay / out-of-order sequences are ignored (seq stays at or below the last one seen)
        let seen = notice(NoticeKind.DONE, "s2")            // seq 3, applied
        XCTAssertFalse(p.onNotice(seen, on).isEmpty)
        XCTAssertTrue(p.onNotice(seen, on).isEmpty)         // same seq: a replay
        let older = notice(NoticeKind.DONE, "s3", ["seq": .int(1)])
        XCTAssertTrue(p.onNotice(older, on).isEmpty)
        // Cancelling one item re-counts; cancelling the last removes the notification
        seq += 2
        let c1 = p.onNotice(notice(NoticeKind.CANCEL, "s1", ["cancel": "approval", "id": "a1"]), on)
        XCTAssertEqual(c1.count, 1)
        if case .post(let post) = c1[0] {
            XCTAssertEqual(post.pending, 1)
            XCTAssertTrue(post.silent)
        } else { XCTFail() }
        seq += 1
        let c2 = p.onNotice(notice(NoticeKind.CANCEL, "s1", ["cancel": "approval"]), on)
        XCTAssertEqual(c2, [.cancel(.init(key: "h1|s1"))])
        // A cancel for a conversation we have no state for still cancels
        seq += 1
        XCTAssertEqual(p.onNotice(notice(NoticeKind.CANCEL, "sX", ["cancel": "approval"]), on),
                       [.cancel(.init(key: "h1|sX"))])
    }

    func testDoneBundle() {
        seq = 0; let p = NotifyPlanner()
        // One completion alerts on its own
        let a1 = p.onNotice(notice(NoticeKind.DONE, "s1"), on)
        XCTAssertEqual(a1, [.post(.init(key: "h1|s1", kind: NoticeKind.DONE, hostId: "h1", host: "main-pc",
                                      session: "s1", title: "t-s1", at: 1, attention: false))])
        // The second completion: it posts quietly and a bundle on top carries the alert
        let a2 = p.onNotice(notice(NoticeKind.DONE, "s2"), on)
        XCTAssertEqual(a2, [.post(.init(key: "h1|s2", kind: NoticeKind.DONE, hostId: "h1", host: "main-pc",
                                      session: "s2", title: "t-s2", at: 2, attention: false, silent: true)),
                            .bundle(.init(key: "h1|bundle", hostId: "h1", host: "main-pc", count: 2,
                                          titles: ["t-s2", "t-s1"], session: "s2", at: 2))])
        // A third: bundle re-counts and alerts once
        let a3 = p.onNotice(notice(NoticeKind.DONE, "s3"), on)
        XCTAssertEqual(a3.last, .bundle(.init(key: "h1|bundle", hostId: "h1", host: "main-pc", count: 3,
                                            titles: ["t-s3", "t-s2", "t-s1"], session: "s3", at: 3)))
        // "seen" removes the completion's own notification and quietly re-counts the bundle
        seq += 1
        let seen = p.onNotice(notice(NoticeKind.CANCEL, "s2", ["cancel": "seen"]), on)
        XCTAssertEqual(seen, [.cancel(.init(key: "h1|s2")),
                              .bundle(.init(key: "h1|bundle", hostId: "h1", host: "main-pc", count: 2,
                                            titles: ["t-s3", "t-s1"], session: "s3", at: 3, silent: true))])
        // Down to one: the bundle goes away, the remaining completion keeps its quiet notification
        seq += 1
        let seen2 = p.onNotice(notice(NoticeKind.CANCEL, "s1", ["cancel": "seen"]), on)
        XCTAssertEqual(seen2, [.cancel(.init(key: "h1|s1")), .cancel(.init(key: "h1|bundle"))])
    }

    func testOpened() {
        seq = 0; let p = NotifyPlanner()
        _ = p.onNotice(notice(NoticeKind.DONE, "s1"), on)
        _ = p.onNotice(notice(NoticeKind.DONE, "s2"), on)
        _ = p.onNotice(notice(NoticeKind.DONE, "s3"), on)
        // Tapping a completion: it and the quiet re-count of the bundle
        let tap = p.opened("h1", "s2", false)
        XCTAssertEqual(tap, [.cancel(.init(key: "h1|s2")),
                             .bundle(.init(key: "h1|bundle", hostId: "h1", host: "main-pc", count: 2,
                                           titles: ["t-s3", "t-s1"], session: "s3", at: 3, silent: true))])
        // Tapping the bundle acknowledges every completion
        let all = p.opened("h1", nil, true)
        XCTAssertEqual(Set(keys(all)), ["h1|s1", "h1|s3", "h1|bundle"])
        XCTAssertTrue(p.opened("h1", "s1", false).isEmpty)   // nothing left
        XCTAssertTrue(p.opened("nohost", "s1", false).isEmpty)
    }

    func testAttentionKinds() {
        seq = 0; let p = NotifyPlanner()
        for kind in [NoticeKind.APPROVAL, NoticeKind.QUESTION, NoticeKind.FAILED, NoticeKind.SCHEDULE_MISSED] {
            let acts = p.onNotice(notice(kind, "s-\(kind)", ["id": .string("i-\(kind)")]), on)
            guard case .post(let post) = acts.last else { return XCTFail(kind) }
            XCTAssertTrue(post.attention, kind)
        }
        // A failure overwrites a completion: the completion's count drops out of the bundle
        _ = p.onNotice(notice(NoticeKind.DONE, "d1"), on)
        _ = p.onNotice(notice(NoticeKind.DONE, "d2"), on)
        let fail = p.onNotice(notice(NoticeKind.FAILED, "d1"), on)
        XCTAssertEqual(fail.last, .cancel(.init(key: "h1|bundle")))
        // "seen" on a failure removes it
        seq += 1
        XCTAssertEqual(p.onNotice(notice(NoticeKind.CANCEL, "d1", ["cancel": "seen"]), on),
                       [.cancel(.init(key: "h1|d1"))])
    }

    func testDeviceNotice() {
        seq = 0; let p = NotifyPlanner()
        let acts = p.onNotice(notice(NoticeKind.DEVICE, "", ["id": "dev-9", "title": "Galaxy Tab"]), on)
        XCTAssertEqual(acts, [.post(.init(key: "h1|device:dev-9", kind: NoticeKind.DEVICE, hostId: "h1",
                                        host: "main-pc", session: "", title: "Galaxy Tab", at: 1, attention: true))])
        seq += 1
        XCTAssertEqual(p.onNotice(notice(NoticeKind.CANCEL, "", ["cancel": "device", "id": "dev-9"]), on),
                       [.cancel(.init(key: "h1|device:dev-9"))])
        // reply off → no device notice
        seq += 1
        XCTAssertTrue(p.onNotice(notice(NoticeKind.DEVICE, "", ["id": "d2"]), NotifySettings(enabled: true, reply: false)).isEmpty)
    }

    func testSettingsGates() {
        seq = 0; let p = NotifyPlanner()
        let off = NotifySettings(enabled: false)
        XCTAssertTrue(p.onNotice(notice(NoticeKind.APPROVAL, "s", ["id": "a"]), off).isEmpty)
        XCTAssertTrue(p.onNotice(notice(NoticeKind.DONE, "s"), off).isEmpty)
        // Each kind follows its own switch
        XCTAssertTrue(p.onNotice(notice(NoticeKind.APPROVAL, "s", ["id": "a"]), NotifySettings(enabled: true, reply: false)).isEmpty)
        XCTAssertTrue(p.onNotice(notice(NoticeKind.FAILED, "s"), NotifySettings(enabled: true, failed: false)).isEmpty)
        XCTAssertTrue(p.onNotice(notice(NoticeKind.DONE, "s"), NotifySettings(enabled: true, done: false)).isEmpty)
    }
}
