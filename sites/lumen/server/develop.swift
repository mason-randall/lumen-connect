// Lumen's raw developer, with Apple's Core Image raw engine (macOS): it demosaics a camera raw (Sony ARW, Canon CR2/CR3,
// Nikon NEF, Fujifilm RAF, DNG, …), applies the camera's color matrix and lens corrections, and writes the result as
// scene-linear light: no tone curve, no clipping of what's above white, in a wide gamut (linear Rec. 2020), as half floats.
// Lumen's engine does everything after that (exposure, white balance, the tone curve, color) in the browser, on the GPU.
//
//   develop <raw> <out.bin> <maxSide>
//
// out.bin: the pixels, RGBA half floats (little-endian), row by row from the top. It prints
// {"width":…, "height":…, "camera":"…", "temperature":…, "tint":…, "baselineExposure":…, "native":[w,h]} — the as-shot
// white balance (Kelvin, tint) is what the picture was decoded with; Lumen's white balance is relative to it.
import CoreImage
import Foundation

let args = CommandLine.arguments
guard args.count == 4, let maxSide = Double(args[3]) else { fatalError("usage: develop <raw> <out.bin> <maxSide>") }
let url = URL(fileURLWithPath: args[1])
guard let raw = CIRAWFilter(imageURL: url) else { fatalError("not a raw this Mac can read") }

// Linear: no boost (the default tone curve), no shadow boost, no gamut mapping (the engine maps gamut itself). The
// camera's baseline exposure stays: it's what puts a normally exposed scene at a normal level.
raw.boostAmount = 0
raw.isGamutMappingEnabled = false
raw.extendedDynamicRangeAmount = 0
// Scaled during the demosaic (sharper and faster than shrinking afterwards).
let native = raw.nativeSize
// Core Image takes anything, and makes nothing of what it can't read: a 0×0 picture is not a raw it knows.
guard native.width > 0, native.height > 0 else { fatalError("not a raw this Mac can read") }
raw.scaleFactor = Float(min(1, maxSide / max(native.width, native.height)))

guard let image = raw.outputImage else { fatalError("couldn't develop it") }
let space = CGColorSpace(name: CGColorSpace.extendedLinearITUR_2020)!
let context = CIContext(options: [.workingColorSpace: space, .workingFormat: CIFormat.RGBAh, .cacheIntermediates: false])
let extent = image.extent.integral
let w = Int(extent.width), h = Int(extent.height)
guard w > 0, h > 0, !extent.isInfinite else { fatalError("not a raw this Mac can read") }
var data = Data(count: w * h * 8)
data.withUnsafeMutableBytes { buf in
  context.render(image, toBitmap: buf.baseAddress!, rowBytes: w * 8, bounds: extent, format: .RGBAh, colorSpace: space)
}
try data.write(to: URL(fileURLWithPath: args[2]))

let info: [String: Any] = [
  "width": w, "height": h,
  "camera": raw.properties["{TIFF}"].flatMap { ($0 as? [String: Any])?["Model"] as? String } ?? "",
  "temperature": raw.neutralTemperature, "tint": raw.neutralTint,
  "baselineExposure": raw.baselineExposure,
  "native": [Int(native.width), Int(native.height)],
]
let json = try JSONSerialization.data(withJSONObject: info)
print(String(data: json, encoding: .utf8)!)
