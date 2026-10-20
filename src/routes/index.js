import { Router } from 'express';
import authRoutes from '../api/Auth/auth.routes.js';
import contactRoutes from '../api/Contact/contact.routes.js';
import documentRoutes from '../api/Documents/documents.routes.js';
import downloadRoutes from '../api/Downloads/downloads.routes.js';
import homepageRoutes from '../api/Homepage/homepage.routes.js';

const router = Router();

router.use('/contact', contactRoutes);
router.use('/auth', authRoutes);
router.use('/downloads', downloadRoutes);
router.use('/documents', documentRoutes);
router.use('/homepage', homepageRoutes);

export default router;
