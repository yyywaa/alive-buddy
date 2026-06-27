import os
import joblib
import pandas as pd
from sklearn.ensemble import RandomForestClassifier

class ProactiveModel:
    """
    负责决策树模型的生命周期管理：加载、保存、预测与训练。
    使用 RandomForestClassifier，通过 predict_proba 输出连续唤醒概率。
    """
    def __init__(self, model_path: str):
        self.model_path = model_path
        self.model = None
        self.load()

    def load(self) -> None:
        if os.path.exists(self.model_path):
            self.model = joblib.load(self.model_path)
            print(f"[ML] Model loaded from {self.model_path}")
        else:
            print(f"[ML] Warning: Model file not found at {self.model_path}. Please train the model first.")
            self.model = None

    def save(self) -> None:
        if self.model is not None:
            joblib.dump(self.model, self.model_path)
            print(f"[ML] Model saved to {self.model_path}")

    def train(self, data: pd.DataFrame) -> None:
        """
        基于外部传入的 DataFrame 训练模型。
        要求 data 中包含特征列以及对应的 'target' 列（0 或 1）。
        """
        if 'target' not in data.columns:
            raise ValueError("Training data must contain a 'target' column.")
            
        X = data.drop('target', axis=1)
        y = data['target']
        
        self.model = RandomForestClassifier(n_estimators=100, max_depth=5, random_state=42)
        self.model.fit(X, y)
        self.save()

    def predict(self, features: dict) -> float:
        """
        接收特征字典，返回唤醒概率（正类的 predict_proba）。
        每棵树独立投票 0/1，森林取均值 → 连续概率。
        """
        if self.model is None:
            raise RuntimeError("Model is not initialized or trained yet.")
            
        X = pd.DataFrame([features])
        # predict_proba 返回 [P(class=0), P(class=1)]，取正类概率
        return float(self.model.predict_proba(X)[0][1])
