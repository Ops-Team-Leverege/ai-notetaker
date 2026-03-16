import app from './app';
import { closePool } from './db';

const PORT = parseInt(process.env.PORT || '8080', 10);

const server = app.listen(PORT, () => {
    console.log(`API server listening on port ${PORT}`);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
    server.close();
    await closePool();
    process.exit(0);
});
