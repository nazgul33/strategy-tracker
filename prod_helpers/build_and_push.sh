#!/bin/bash
docker buildx build --platform linux/amd64 -t 10.33.32.2:5050/strategy-tracker --push .
