import express from 'express';
import { sendContactEmail, getStatus } from './contact.controller.js';

const router = express.Router();

router.get('/status', getStatus);
router.post('/', sendContactEmail);

export default router;