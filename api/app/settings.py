from pydantic import model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

DEFAULT_TOKEN = "dev-token-change-me"


class Settings(BaseSettings):
    """Read from the environment (or a .env next to the working directory).

    DATABASE_URL uses the psycopg 3 driver name; SQLAlchemy needs the
    `postgresql+psycopg://` scheme, not bare `postgresql://`.
    """

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str = "postgresql+psycopg://postgres:postgres@127.0.0.1:5432/invoice_provenance"
    workspace_token: str = DEFAULT_TOKEN
    # "dev" is the only environment allowed to run on the default token. Compose
    # passes APP_ENV through; a deploy that forgets to set both refuses to start
    # instead of serving a workspace anyone can write to.
    app_env: str = "dev"

    @model_validator(mode="after")
    def _refuse_default_token_outside_dev(self) -> "Settings":
        if self.app_env != "dev" and self.workspace_token == DEFAULT_TOKEN:
            raise ValueError(f"APP_ENV={self.app_env} with the default WORKSPACE_TOKEN; set WORKSPACE_TOKEN before starting")
        return self


settings = Settings()
