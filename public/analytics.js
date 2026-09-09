/**
 * Vercel Web Analytics initialization
 * This script initializes Vercel Web Analytics for the Vaelos application
 */

// Import the inject function from @vercel/analytics
import { inject } from './vendor/analytics.mjs';

// Initialize analytics
inject({
  mode: 'auto', // Automatically detect environment (production/development)
  debug: true,  // Enable debug logging in development
});
