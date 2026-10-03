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
	python3 -m unittest discover -s deploy -p '*_test.py'
	bash -n deploy/receive.sh deploy/bootstrap-vds.sh deploy/bootstrap-proxy.sh

test-campaign:
	npm run test:campaign
