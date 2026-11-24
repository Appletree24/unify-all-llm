import Foundation
import AVFoundation
import PDFKit
import Vision
#if compiler(>=6.2)
import Speech
#endif

private enum AudioFailure: Error {
    case decode
    case message(String)
}

private func recognize(_ handler: VNImageRequestHandler) throws -> String {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.recognitionLanguages = ["zh-Hans", "en-US"]
    try handler.perform([request])
    return (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n")
}

#if compiler(>=6.2)
@available(macOS 26.0, *)
private func transcribe(_ url: URL) async throws -> String {
    guard let file = try? AVAudioFile(forReading: url), file.length > 0 else { throw AudioFailure.decode }
    guard SpeechTranscriber.isAvailable else { throw AudioFailure.message("这台 Mac 的本机语音识别服务不可用") }
    var locale = await SpeechTranscriber.supportedLocale(equivalentTo: Locale.current)
    if locale == nil { locale = await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: "zh-CN")) }
    guard let locale else { throw AudioFailure.message("系统未提供可用的语音识别语言") }
    let module = SpeechTranscriber(locale: locale, preset: .transcription)
    do {
        if let request = try await AssetInventory.assetInstallationRequest(supporting: [module]) {
            try await request.downloadAndInstall()
        }
    } catch {
        throw AudioFailure.message("无法准备\(locale.localizedString(forIdentifier: locale.identifier) ?? locale.identifier)语音资源：\(error.localizedDescription)")
    }
    let analyzer = SpeechAnalyzer(modules: [module])
    async let transcript: String = {
        var pieces: [String] = []
        for try await result in module.results {
            pieces.append(String(result.text.characters))
        }
        return pieces.joined(separator: " ")
    }()
    do {
        try await analyzer.start(inputAudioFile: file, finishAfterFile: true)
    } catch {
        await analyzer.cancelAndFinishNow()
        let cause = error as NSError
        if cause.domain == NSOSStatusErrorDomain || cause.domain == AVFoundationErrorDomain ||
            (cause.domain == SFSpeechErrorDomain && cause.code == SFSpeechError.Code.incompatibleAudioFormats.rawValue) {
            throw AudioFailure.decode
        }
        throw error
    }
    return try await transcript
}
#endif

@main struct MaterialText {
    static func main() async throws {
        guard CommandLine.arguments.count == 3 else { return }
        let url = URL(fileURLWithPath: CommandLine.arguments[2])
        switch CommandLine.arguments[1] {
        case "pdf":
            if let doc = PDFDocument(url: url) {
                for i in 0..<min(doc.pageCount, 40) {
                    if let page = doc.page(at: i) { print(page.string ?? "") }
                }
            }
        case "image":
            print(try recognize(VNImageRequestHandler(url: url)))
        case "audio":
            do {
#if compiler(>=6.2)
                if #available(macOS 26.0, *) {
                    print(try await transcribe(url))
                    return
                }
#endif
                throw AudioFailure.message("本机语音转写需要 macOS 26 或更高版本及相应的语音工具")
            } catch AudioFailure.decode {
                exit(65)
            } catch {
                let reason: String
                if case AudioFailure.message(let message) = error { reason = message }
                else { reason = "语音识别失败：\(error.localizedDescription)" }
                FileHandle.standardError.write(Data(("Unify: " + reason + "\n").utf8))
                exit(1)
            }
        case "video":
            let asset = AVURLAsset(url: url)
            let duration = try await asset.load(.duration).seconds
            guard duration.isFinite && duration > 0 else { return }
            let generator = AVAssetImageGenerator(asset: asset)
            generator.appliesPreferredTrackTransform = true
            generator.maximumSize = CGSize(width: 1600, height: 1200)
            var seen = Set<String>()
            for index in 0..<min(8, max(1, Int(ceil(duration)))) {
                let t = duration * Double(index) / Double(min(8, max(1, Int(ceil(duration)))))
                let frame = try? await generator.image(at: CMTime(seconds: t, preferredTimescale: 600)).image
                if let frame, let text = try? recognize(VNImageRequestHandler(cgImage: frame)), !text.isEmpty, seen.insert(text).inserted {
                    print("[\(Int(t))s] \(text)")
                }
            }
        default: break
        }
    }
}
