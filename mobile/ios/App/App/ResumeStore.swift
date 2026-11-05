// 前回開いていたホストとその経路（自分の中継 "own" / 公式の中継 "plus"）を覚える。一覧へ戻ったときとホストを削除したときに消す。
import Foundation
enum ResumeStore {
    private static let hostKey = "resume.hostId"
    private static let viaKey = "resume.via"

    static func hostId() -> String? { UserDefaults.standard.string(forKey: hostKey) }
    static func via() -> String? { UserDefaults.standard.string(forKey: viaKey).flatMap { $0 == "own" || $0 == "plus" ? $0 : nil } }

    static func remember(_ hostId: String, via: String = "own") {
        UserDefaults.standard.set(hostId, forKey: hostKey)
        UserDefaults.standard.set(via, forKey: viaKey)
    }
    static func forget(_ hostId: String? = nil) {
        if hostId == nil || UserDefaults.standard.string(forKey: hostKey) == hostId {
            UserDefaults.standard.removeObject(forKey: hostKey)
            UserDefaults.standard.removeObject(forKey: viaKey)
        }
    }
}
