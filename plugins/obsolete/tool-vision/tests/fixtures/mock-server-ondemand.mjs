// On-demand mock llama-server: spawned as a child process by the smoke test to
// verify autoStart. Listens on VISION_TEST_PORT and answers /v1/models and
// /v1/chat/completions like llama-server's OpenAI-compatible API.
import http from 'node:http';

const port = Number(process.argv[2] || process.env.VISION_TEST_PORT);
if (!Number.isInteger(port) || port <= 0) {
    console.error('VISION_TEST_PORT must be a positive integer (or pass it as argv[2])');
    process.exit(1);
}

const server = http.createServer((req, res) => {
    if (req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'ondemand-vision' }] }));
        return;
    }
    if (req.url === '/v1/chat/completions' && req.method === 'POST') {
        let body = '';
        req.on('data', (chunk) => (body += chunk));
        req.on('end', () => {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(
                JSON.stringify({
                    model: 'ondemand-vision',
                    choices: [{ message: { content: 'ondemand 描述' } }],
                }),
            );
        });
        return;
    }
    res.writeHead(404);
    res.end('not found');
});

server.listen(port, '127.0.0.1');
