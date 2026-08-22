# Warehouse Log

## 2026-08-21

- Assumption: when a batch pattern has `analysisStatus: "analyzed_from_color_modal"`, the color modal image is treated as the analysis source, not the visual thumbnail. Project thumbnails should prefer `results/batch_pic/<ImageId>/<ImageId>_1.PNG` and only fall back to `sourceImages[0]` if the primary image is unavailable.
