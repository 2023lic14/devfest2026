from __future__ import annotations

"""FastAPI application entrypoint for the Main Character Moment backend."""

from fastapi import FastAPI

from src.routes.generate import router as generate_router
from src.routes.status import router as status_router
from src.services.db import init_db


def create_app() -> FastAPI:
	"""Create and configure the FastAPI app instance."""
	init_db()
	app = FastAPI(title="Main Character Moment API", version="1.0.0")

	app.include_router(generate_router)
	app.include_router(status_router)

	return app


app = create_app()
