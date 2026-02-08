from __future__ import annotations

"""FastAPI application entrypoint for the Main Character Moment backend."""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from src.routes.generate import router as generate_router
from src.routes.status import router as status_router
from src.services.db import init_db


def create_app() -> FastAPI:
	"""Create and configure the FastAPI app instance."""
	init_db()
	app = FastAPI(title="Main Character Moment API", version="1.0.0")

	app.add_middleware(
		CORSMiddleware,
		allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
		allow_credentials=True,
		allow_methods=["*"],
		allow_headers=["*"],
	)

	app.include_router(generate_router)
	app.include_router(status_router)

	return app


app = create_app()
