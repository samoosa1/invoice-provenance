"""One shared workspace behind one token. Not multi-tenant, and the README
says so; `workspace_id` is already on every row so tenancy is a later
migration, not a redesign.

The workspace row is created on first authenticated request rather than by
a migration: a data migration would have to know the token at migration
time, which ties schema history to an environment variable.
"""
from __future__ import annotations

import hashlib
import secrets

from fastapi import Depends, Header, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from .db import get_session
from .models import Workspace
from .settings import settings


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def require_workspace(
    x_workspace_token: str | None = Header(default=None),
    session: Session = Depends(get_session),
) -> Workspace:
    if x_workspace_token is None or not secrets.compare_digest(x_workspace_token, settings.workspace_token):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="missing or invalid X-Workspace-Token")
    h = token_hash(x_workspace_token)
    ws = session.scalar(select(Workspace).where(Workspace.token_hash == h))
    if ws is None:
        ws = Workspace(name="demo", token_hash=h)
        session.add(ws)
        session.commit()
    return ws
