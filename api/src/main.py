from __future__ import annotations

"""FastAPI application entrypoint for the Main Character Moment backend."""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from src.config import settings
from src.routes.generate import router as generate_router
from src.routes.status import router as status_router
from src.services.db import init_db


def create_app() -> FastAPI:
	"""Create and configure the FastAPI app instance."""
	init_db()
	app = FastAPI(title="Main Character Moment API", version="1.0.0")

	raw_origins = (settings.cors_allow_origins or "").strip()
	if raw_origins == "*":
		allow_origins = ["*"]
		allow_credentials = False
	else:
		allow_origins = [o.strip() for o in raw_origins.split(",") if o.strip()]
		allow_credentials = True

	app.add_middleware(
		CORSMiddleware,
		allow_origins=allow_origins,
		allow_credentials=allow_credentials,
		allow_methods=["*"],
		allow_headers=["*"],
	)

	app.include_router(generate_router)
	app.include_router(status_router)

	return app


app = create_app()
