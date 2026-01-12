# Custom Domain Setup for Zivv

This document outlines the steps to set up custom domain hosting for the Zivv application using GitHub Pages.

## Overview

The application has been configured to use `zivv.app` as the custom domain, replacing the GitHub Pages subdirectory hosting (`/zivv/`).

## Domain Configuration Steps

### 1. Domain Registration

**Recommended domains:**
- `zivv.app` (configured in CNAME)
- `punkshows.bay`
- `zivvbay.com`

Register the domain through a registrar like:
- Namecheap
- GoDaddy
- Cloudflare Registrar
- Google Domains

### 2. DNS Configuration

Configure the following DNS records with your domain registrar:

**For Apex Domain (zivv.app):**
```
Type: A
Name: @
Value: 185.199.108.153

Type: A
Name: @
Value: 185.199.109.153

Type: A
Name: @
Value: 185.199.110.153

Type: A
Name: @
Value: 185.199.111.153
```

**For WWW Subdomain (optional):**
```
Type: CNAME
Name: www
Value: prodigic.github.io
```

**Note:** Replace `prodigic` with your actual GitHub username if different.

### 3. GitHub Pages Configuration

1. **Repository Settings:**
   - Go to Settings → Pages
   - Source: Deploy from a branch
   - Branch: `gh-pages` (auto-managed by deployment workflow)

2. **Custom Domain:**
   - GitHub will automatically detect the `public/CNAME` file
   - Verify the domain appears in Settings → Pages
   - Enable "Enforce HTTPS" once SSL certificate is active

### 4. SSL Certificate Setup

GitHub Pages automatically provisions Let's Encrypt certificates for custom domains:

1. After DNS propagation (24-48 hours)
2. GitHub will automatically request SSL certificate
3. Certificate auto-renews every 90 days
4. HTTPS becomes available at `https://zivv.app`

### 5. Verification Steps

**DNS Propagation Check:**
```bash
# Check A records
dig zivv.app A

# Check CNAME (if using www)
dig www.zivv.app CNAME

# Verify GitHub Pages IP resolution
nslookup zivv.app
```

**Website Accessibility:**
1. Visit `http://zivv.app` (should redirect to HTTPS)
2. Visit `https://zivv.app` (should load application)
3. Test SPA routing: `https://zivv.app/calendar`
4. Verify PWA manifest: `https://zivv.app/manifest.json`

### 6. Deployment Integration

The deployment workflow automatically handles:
- ✅ Building application with root path (`base: "/"`)
- ✅ Deploying to `gh-pages` branch
- ✅ CNAME file inclusion in build
- ✅ 404.html for SPA routing

No additional deployment configuration required.

## Files Modified for Custom Domain

| File | Changes |
|------|---------|
| `public/CNAME` | **NEW** - Contains `zivv.app` domain |
| `vite.config.ts` | **UPDATED** - Base path changed from `/zivv/` to `/` |
| `public/manifest.json` | **VERIFIED** - Already configured with `/` scope |

## Troubleshooting

### Domain Not Resolving
1. **Check DNS Propagation:** Use online tools like `whatsmydns.net`
2. **Verify A Records:** Ensure all 4 GitHub Pages IP addresses are configured
3. **TTL Settings:** Lower TTL (300 seconds) for faster updates during setup

### SSL Certificate Issues
1. **Wait for Provisioning:** Can take 24-48 hours after DNS setup
2. **Disable/Re-enable HTTPS:** In GitHub Settings → Pages
3. **Clear Browser Cache:** Force refresh to avoid cached HTTP version

### 404 Errors on Routes
1. **Verify 404.html:** Check `public/404.html` exists and deploys
2. **SPA Routing:** Ensure React Router configuration matches base path
3. **GitHub Pages Settings:** Confirm source branch is `gh-pages`

### Build/Deploy Failures
1. **Check Workflow:** `.github/workflows/deploy.yml` runs successfully
2. **Base Path:** Verify `vite.config.ts` uses `base: "/"`
3. **CNAME Conflicts:** Ensure CNAME file contains only the domain name

## Fallback Strategy

If custom domain issues occur:

1. **Immediate Fallback:**
   ```bash
   # Remove CNAME file temporarily
   git rm public/CNAME

   # Revert vite.config.ts base path
   # base: process.env.NODE_ENV === "production" ? "/zivv/" : "/"

   git commit -m "revert: temporarily disable custom domain"
   git push
   ```

2. **Site Accessible At:** `https://prodigic.github.io/zivv/`

3. **Re-enable:** Restore CNAME and base path once domain issues resolved

## Performance Considerations

**Custom Domain Benefits:**
- ✅ Professional branding (`zivv.app` vs `github.io/zivv`)
- ✅ Shorter URLs for sharing
- ✅ Better SEO with custom domain
- ✅ Root path deployment (cleaner URLs)

**GitHub Pages Limitations:**
- 🔄 Static hosting only (no server-side processing)
- 🔄 1GB repository size limit
- 🔄 100GB monthly bandwidth limit
- 🔄 10 builds per hour limit

## Domain Costs

**Annual Domain Costs (estimates):**
- `.app` domains: $12-20/year
- `.com` domains: $10-15/year
- `.bay` domains: $15-25/year (newer TLD)

**Hosting Cost:** $0 (GitHub Pages is free for public repositories)

## Next Steps After Domain Setup

1. **Update Documentation:** Replace GitHub Pages URLs with custom domain
2. **SEO Setup:** Submit sitemap to Google Search Console
3. **Analytics:** Update tracking codes with new domain
4. **Social Media:** Update links in project descriptions
5. **README Badges:** Update demo links to use custom domain

## Support

If domain setup issues persist:
- GitHub Pages Documentation: https://docs.github.com/en/pages
- GitHub Community Support: https://github.community/
- Project Issues: https://github.com/prodigic/zivv/issues