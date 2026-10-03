.PHONY: build run dev check test-campaign

build:
	npm run build
	go build -o bin/korovany ./cmd/korovany

run:
	go run ./cmd/korovany

dev:
	npm run dev

check:
	npm run check
	npm test
	go test -race ./...
	go vet ./...

test-campaign:
	npm run test:campaign
