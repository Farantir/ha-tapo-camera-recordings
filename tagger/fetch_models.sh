#!/bin/sh
# Downloads the two models into MODELS_DIR (default ./models).
#
# Detector: YOLOv10, COCO. Only used to find subjects and hand back a box —
# its class labels are not trusted, because COCO has no hedgehog or squirrel.
# Size picks accuracy: yolov10n is 9 MB and quick, yolov10x is 118 MB and
# noticeably better on small, distant, motion-blurred animals.
#
# Classifier: Google SpeciesNet v4.0.1a, trained on camera-trap imagery.
# 2498 labels forming a full taxonomy, including "blank" and "vehicle".
set -eu

MODELS_DIR="${MODELS_DIR:-./models}"
DETECTOR="${DETECTOR:-yolov10x}"

DETECTOR_URL="https://huggingface.co/onnx-community/${DETECTOR}/resolve/main/onnx/model.onnx"
CLASSIFIER_URL="https://huggingface.co/daslearning/Google-SpeciesNet-ONNX/resolve/main/onnx/spicesNet_v401a.onnx"
LABELS_URL="https://huggingface.co/Addax-Data-Science/SPECIESNET-v4-0-1-A-v1/resolve/main/always_crop_99710272_22x8_v12_epoch_00148.labels.txt"

mkdir -p "$MODELS_DIR"

# A truncated model file parses as invalid protobuf much later and much more
# confusingly, so every download is checked against the length the server
# advertised before it is moved into place.
fetch() {
  url="$1"; dest="$2"
  if [ -s "$dest" ]; then
    echo "have $(basename "$dest")"
    return 0
  fi
  echo "fetching $(basename "$dest") ..."
  expected=$(curl -sIL "$url" | tr -d '\r' | awk 'tolower($1)=="content-length:"{n=$2} END{print n}')
  curl -fL --retry 3 --retry-delay 2 -o "$dest.part" "$url"
  actual=$(wc -c < "$dest.part" | tr -d ' ')
  if [ -n "$expected" ] && [ "$expected" != "$actual" ]; then
    rm -f "$dest.part"
    echo "  incomplete download: got $actual bytes, expected $expected" >&2
    exit 1
  fi
  mv "$dest.part" "$dest"
  echo "  $(basename "$dest"): $actual bytes"
}

fetch "$DETECTOR_URL"   "$MODELS_DIR/detector.onnx"
fetch "$CLASSIFIER_URL" "$MODELS_DIR/classifier.onnx"
fetch "$LABELS_URL"     "$MODELS_DIR/classifier.labels.txt"

echo "models ready in $MODELS_DIR"
