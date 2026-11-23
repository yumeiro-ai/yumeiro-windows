"""SenseVoiceSmall 的 OpenAI 兼容封装：POST /v1/audio/transcriptions。
中文（含粤语）、英、日、韩效果好，CPU 即可运行，约占 1~2GB 内存。
未经本项目实机验证；funasr 版本更新后接口可能有变化。"""
import os, tempfile, secrets
from fastapi import FastAPI, File, Form, Header, HTTPException, UploadFile
from funasr import AutoModel
from funasr.utils.postprocess_utils import rich_transcription_postprocess

API_KEY = os.environ.get("ASR_API_KEY", "")  # 留空则不校验（只在内网使用时可以留空）
MODEL = os.environ.get("ASR_MODEL", "iic/SenseVoiceSmall")
LANGS = {"zh", "en", "yue", "ja", "ko", "auto"}

model = AutoModel(model=MODEL, vad_model="fsmn-vad", vad_kwargs={"max_single_segment_time": 30000}, device="cpu", disable_update=True)
app = FastAPI()


@app.get("/health")
def health():
    return {"ok": True}


@app.post("/v1/audio/transcriptions")
async def transcriptions(file: UploadFile = File(...), model_name: str = Form("sensevoice", alias="model"), language: str = Form("auto"),
                         prompt: str = Form(""), response_format: str = Form("json"), authorization: str = Header("")):
    if API_KEY and not secrets.compare_digest(authorization, "Bearer " + API_KEY):
        raise HTTPException(401, "invalid api key")
    data = await file.read()
    if len(data) > 20 * 1024 * 1024:
        raise HTTPException(413, "audio too large")
    suffix = os.path.splitext(file.filename or "")[1] or ".wav"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=True) as tmp:
        tmp.write(data); tmp.flush()
        result = model.generate(input=tmp.name, cache={}, language=language if language in LANGS else "auto", use_itn=True, batch_size_s=60, merge_vad=True, merge_length_s=15)
    text = rich_transcription_postprocess(result[0]["text"]) if result else ""
    return {"text": text}
