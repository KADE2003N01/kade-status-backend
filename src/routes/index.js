import { Router } from 'express';
import authRoutes from '../api/Auth/auth.routes.js';
import platformAuthRoutes from '../api/PlatformAuth/platform-auth.routes.js';
import customerWorkspaceRoutes from '../api/PlatformAuth/customer-workspace.routes.js';
import contactRoutes from '../api/Contact/contact.routes.js';
import documentRoutes from '../api/Documents/documents.routes.js';
import downloadRoutes from '../api/Downloads/downloads.routes.js';
import homepageRoutes from '../api/Homepage/homepage.routes.js';
import platformOwnerRoutes from '../api/PlatformOwner/platform-owner.routes.js';
import platformOwnerCustomerRoutes from '../api/PlatformOwner/platform-owner-customers.routes.js';
import platformOwnerCustomerChatRoutes from '../api/PlatformOwner/platform-owner-customer-chat.routes.js';
import supportRoutes from '../api/Support/support.routes.js';
import messageRoutes from '../api/Messages/messages.routes.js';
import portfolioRoutes from '../api/Portfolios/portfolios.routes.js';
import publicPortfolioRoutes from '../api/Portfolios/public-portfolios.routes.js';
import recruiterRoutes from '../api/Portfolios/recruiter.routes.js';

const router = Router();

router.use('/contact', contactRoutes);
router.use('/auth', authRoutes);
router.use('/platform-auth', platformAuthRoutes);
router.use('/customer-workspace', customerWorkspaceRoutes);
router.use('/platform-owner', platformOwnerRoutes);
router.use('/platform-owner', platformOwnerCustomerRoutes);
router.use('/platform-owner', platformOwnerCustomerChatRoutes);
router.use('/support-requests', supportRoutes);
router.use('/messages', messageRoutes);
router.use('/downloads', downloadRoutes);
router.use('/documents', documentRoutes);
router.use('/homepage', homepageRoutes);
router.use('/portfolios', portfolioRoutes);
router.use('/public', recruiterRoutes);
router.use('/public', publicPortfolioRoutes);

export default router;
