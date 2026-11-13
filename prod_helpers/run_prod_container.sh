#!/bin/bash
docker stop stratagy_tracker_prod; docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --build
