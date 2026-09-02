# alive-buddy ML sidecar（主动发言决策树推理）
FROM python:3.11-slim
WORKDIR /app
RUN pip install --no-cache-dir scikit-learn pandas numpy fastapi uvicorn
COPY src/ml/app.py src/ml/model.py src/ml/proactive_model.pkl ./
ENV HOST=0.0.0.0 PORT=8001
EXPOSE 8001
CMD ["python", "app.py"]
