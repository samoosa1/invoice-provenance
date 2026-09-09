from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Read from the environment (or a .env next to the working directory).

    DATABASE_URL uses the psycopg 3 driver name; SQLAlchemy needs the
    `postgresql+psycopg://` scheme, not bare `postgresql://`.
    """

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str = "postgresql+psycopg://postgres:postgres@127.0.0.1:5432/invoice_provenance"
    workspace_token: str = "dev-token-change-me"


settings = Settings()
