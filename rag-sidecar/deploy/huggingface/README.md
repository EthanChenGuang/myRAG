---
title: myRAG sidecar
colorFrom: gray
colorTo: blue
sdk: docker
app_port: 8000
pinned: false
short_description: myRAG RAG sidecar (runtime image, no models)
---

Private deployment of the myRAG rag-sidecar `runtime` image. Every route except `/health` and `/ready` needs the
`x-sidecar-secret` header. Operator notes live in the myRAG repository at
`rag-sidecar/deploy/huggingface/README-operator.md`.
