import os
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from model import ProactiveModel

app = FastAPI(title="alive-buddy ML Sidecar")

# 默认使用 8001，避免与 ChromaDB 默认端口 8000 冲突
DEFAULT_PORT = int(os.getenv("PORT", "8001"))
DEFAULT_HOST = os.getenv("HOST", "127.0.0.1")

# 初始化模型管理器
MODEL_PATH = os.path.join(os.path.dirname(__file__), "proactive_model.pkl")
proactive_model = ProactiveModel(model_path=MODEL_PATH)

# 输入特征约束
class Features(BaseModel):
    is_breaking_time: bool
    is_working_time: bool
    is_sleeping_time: bool
    time_cos: float
    time_since_last_msg: float
    mood: int
    boredom: int
    energy: int
    noise: float

@app.post("/predict")
def predict(features: Features):
    """
    提供给 TS 侧边栏的推理接口。
    """
    try:
        prob = proactive_model.predict(features.model_dump())
        return {"probability": prob}
    except RuntimeError as e:
        # 抛出 503 代表模型未就绪
        raise HTTPException(status_code=503, detail=str(e))


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host=DEFAULT_HOST, port=DEFAULT_PORT)
