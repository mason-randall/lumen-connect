// Lumen's photo analysis, with Apple's Vision (macOS): the subject (what stands out from the background, people and
// what they hold) as a soft mask, and each face with its eyes. Lumen's server runs it on the photo you open.
//
//   analyze <image> <mask.png>     prints {"width":…, "height":…, "subject":true|false, "faces":[{"box":[x,y,w,h], "eyes":[[x,y,r], …]}]}
//
// Boxes and points are shares of the image (top-left origin); the mask is a grayscale PNG the size of the image.
import CoreImage
import Foundation
import ImageIO
import UniformTypeIdentifiers
import Vision

let args = CommandLine.arguments
guard args.count == 3 else { fatalError("usage: analyze <image> <mask.png>") }
let url = URL(fileURLWithPath: args[1])
guard let source = CGImageSourceCreateWithURL(url as CFURL, nil), let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else { fatalError("can't read the image") }
let handler = VNImageRequestHandler(cgImage: image)
let W = Double(image.width), H = Double(image.height)

// The subject: every foreground instance (a person and what they hold); people alone if that finds nothing.
var subject: CIImage? = nil
let foreground = VNGenerateForegroundInstanceMaskRequest()
try? handler.perform([foreground])
if let result = foreground.results?.first, !result.allInstances.isEmpty, let buffer = try? result.generateScaledMaskForImage(forInstances: result.allInstances, from: handler) {
  subject = CIImage(cvPixelBuffer: buffer)
} else {
  let people = VNGeneratePersonSegmentationRequest()
  people.qualityLevel = .accurate
  try? handler.perform([people])
  if let buffer = people.results?.first?.pixelBuffer {
    let m = CIImage(cvPixelBuffer: buffer)
    subject = m.transformed(by: CGAffineTransform(scaleX: W / m.extent.width, y: H / m.extent.height))
  }
}
if let m = subject {
  let gray = CGColorSpace(name: CGColorSpace.linearGray)!
  try CIContext().writePNGRepresentation(of: m.cropped(to: CGRect(x: 0, y: 0, width: W, height: H)), to: URL(fileURLWithPath: args[2]), format: .L8, colorSpace: gray)
}

// Faces, and their eyes (a center and a radius each), from the landmarks.
let landmarks = VNDetectFaceLandmarksRequest()
try? handler.perform([landmarks])
var faces: [[String: Any]] = []
for face in landmarks.results ?? [] {
  let b = face.boundingBox
  var eyes: [[Double]] = []
  for eye in [face.landmarks?.leftEye, face.landmarks?.rightEye].compactMap({ $0 }) {
    let pts = eye.normalizedPoints.map { (Double(b.minX) + Double($0.x) * Double(b.width), 1 - (Double(b.minY) + Double($0.y) * Double(b.height))) }
    guard !pts.isEmpty else { continue }
    let cx = pts.map { $0.0 }.reduce(0, +) / Double(pts.count), cy = pts.map { $0.1 }.reduce(0, +) / Double(pts.count)
    let r = pts.map { hypot(($0.0 - cx) * W, ($0.1 - cy) * H) }.max()! / max(W, H)
    eyes.append([cx, cy, r].map { ($0 * 10000).rounded() / 10000 })
  }
  faces.append(["box": [Double(b.minX), 1 - Double(b.maxY), Double(b.width), Double(b.height)].map { ($0 * 10000).rounded() / 10000 }, "eyes": eyes])
}
let out: [String: Any] = ["width": Int(W), "height": Int(H), "subject": subject != nil, "faces": faces]
print(String(data: try JSONSerialization.data(withJSONObject: out, options: [.sortedKeys]), encoding: .utf8)!)
