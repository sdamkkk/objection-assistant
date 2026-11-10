"""为文件库的 Markdown 分段生成向量（BAAI/bge-m3），供网站上的向量检索使用。

用法：python3 scripts/build-embeddings.py 159212 rules
需要：sentence-transformers（首次运行会从 Hugging Face 下载 BAAI/bge-m3，约 2.2 GB）。CPU 上较慢，2500 段约需一小时。

输出 public/kb/<库编号>/：
  embeddings.bin   每段一个 1024 维向量，按 int8 量化（先归一化，再按每个向量自己的最大绝对值缩放到 ±127）
  embeddings.json  { model, dim, count, chunks: 分段编号的指纹, scale: 每个向量的缩放系数 }
网站上检索时，问题由 Cloudflare Workers AI 的 @cf/baai/bge-m3（同一个模型）转成向量，再与这些向量比较。
"""
import hashlib
import json
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
MODEL = "BAAI/bge-m3"


def context(c: dict) -> str:
    # 与 scripts/eval-retrieval.py 一致：标题 + 章节路径 + 正文
    return f"{c['title']} {c['heading']} {c['text']}"


def fingerprint(chunks: list[dict]) -> str:
    h = hashlib.sha1()
    for c in chunks:
        h.update(c["id"].encode())
        h.update(context(c).encode())
    return h.hexdigest()[:16]


def main() -> None:
    from sentence_transformers import SentenceTransformer

    model = None
    for code in sys.argv[1:] or ["159212", "rules"]:
        lib = ROOT / "public" / "kb" / code
        chunks = json.loads((lib / "chunks.json").read_text())
        texts = [context(c) for c in chunks]
        fp = fingerprint(chunks)
        cache = ROOT / "node_modules" / ".cache" / f"emb-{code}-{fp}.npy"
        if cache.exists():
            emb = np.load(cache)
        else:
            if model is None:
                model = SentenceTransformer(MODEL, device="cpu")
                model.max_seq_length = 512
            emb = model.encode(texts, batch_size=8, normalize_embeddings=True, show_progress_bar=True)
            cache.parent.mkdir(parents=True, exist_ok=True)
            np.save(cache, emb)
        emb = emb / np.linalg.norm(emb, axis=1, keepdims=True)
        scale = np.abs(emb).max(axis=1) / 127.0
        q = np.clip(np.round(emb / scale[:, None]), -127, 127).astype(np.int8)
        (lib / "embeddings.bin").write_bytes(q.tobytes())
        meta = {"model": MODEL, "dim": int(emb.shape[1]), "count": len(chunks), "fingerprint": fp, "scale": [round(float(s), 8) for s in scale]}
        (lib / "embeddings.json").write_text(json.dumps(meta))
        # 量化误差：与原向量的余弦相似度
        back = q.astype(np.float32) * scale[:, None]
        cos = (back * emb).sum(1) / np.linalg.norm(back, axis=1)
        print(f"{code}: {len(chunks)} 段，{q.nbytes / 1e6:.1f} MB，量化后余弦相似度最低 {cos.min():.4f}")


if __name__ == "__main__":
    main()
