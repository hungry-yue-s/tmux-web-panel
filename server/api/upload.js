import { Router } from 'express';
import multer from 'multer';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB

export function sanitizeFilename(name) {
  const cleaned = name
    .replace(/[/\\]/g, '')
    .replace(/\.\./g, '')
    .replace(/[\x00-\x1f\x7f]/g, '');
  return cleaned || 'upload';
}

export function createUploadRouter(uploadDir) {
  mkdirSync(uploadDir, { recursive: true });

  const storage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadDir),
    filename: (_req, file, cb) => {
      const timestamp = Date.now();
      const safe = sanitizeFilename(file.originalname);
      cb(null, `${timestamp}_${safe}`);
    },
  });

  const upload = multer({
    storage,
    limits: { fileSize: MAX_FILE_SIZE },
  });

  const router = Router();

  router.post('/', upload.single('file'), (req, res) => {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        data: null,
        error: 'No file provided',
      });
    }

    res.json({
      success: true,
      data: { path: join(uploadDir, req.file.filename) },
      error: null,
    });
  });

  // Handle multer errors (file too large, etc.)
  router.use((err, _req, res, _next) => {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({
        success: false,
        data: null,
        error: 'File too large (max 20MB)',
      });
    }
    res.status(500).json({
      success: false,
      data: null,
      error: err.message,
    });
  });

  return router;
}
