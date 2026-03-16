import express from 'express';
import authRoutes from './routes/auth';
import meetingsRoutes from './routes/meetings';
import workspaceRoutes from './routes/workspace';
import internalRoutes from './routes/internal';

const app = express();

app.use(express.json());

// Auth routes (public + protected)
app.use('/api/auth', authRoutes);

// Meetings routes (protected)
app.use('/api/meetings', meetingsRoutes);

// Workspace Events API routes (signature-verified)
app.use('/api/workspace', workspaceRoutes);

// Internal routes (Cloud Scheduler, etc.)
app.use('/internal', internalRoutes);

export default app;
