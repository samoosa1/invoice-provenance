from fastapi import FastAPI

app = FastAPI(title="invoice-provenance api", version="0.0.1")


@app.get("/health")
@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}
