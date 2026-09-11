from fastapi import FastAPI

from .routes.corrections import router as corrections_router
from .routes.runs import router as runs_router

app = FastAPI(title="invoice-provenance api", version="0.0.1")
app.include_router(runs_router)
app.include_router(corrections_router)


@app.get("/health")
@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}
