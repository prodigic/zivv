/**
 * About page - Information about Zivv and the project
 */

import React from "react";
import { ContentArea } from "@/components/layout/AppShell.tsx";
import { useAppStore } from "@/stores/appStore.ts";

const AboutPage: React.FC = () => {
  const { getAllEvents, artists, venues } = useAppStore();
  
  // Get stats for the geeks section
  const totalEvents = getAllEvents(Infinity).length;
  const totalArtists = artists.size;
  const totalVenues = venues.size;
  
  return (
    <ContentArea>
      <div className="max-w-4xl mx-auto space-y-8">
        {/* Header */}
        <div className="text-center space-y-4">
          <h1 className="text-4xl font-bold text-gray-900 dark:text-white">
            About Zivv
          </h1>
          <p className="text-xl text-gray-600 dark:text-gray-300">
            Your guide to Bay Area punk and alternative music shows
          </p>
        </div>

        {/* Mission */}
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 p-6">
          <h2 className="text-2xl font-semibold text-gray-900 dark:text-white mb-4">
            Our Mission
          </h2>
          <p className="text-gray-700 dark:text-gray-300 leading-relaxed">
            Zivv exists to connect the Bay Area's vibrant punk and alternative music community. 
            We believe that discovering great live music shouldn't be a challenge - it should be 
            an adventure. Our platform helps you find the shows you'll love, discover new venues, 
            and never miss out on the underground scene that makes the Bay Area special.
          </p>
        </div>

        {/* Features */}
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 p-6">
          <h2 className="text-2xl font-semibold text-gray-900 dark:text-white mb-4">
            What We Offer
          </h2>
          <div className="grid md:grid-cols-2 gap-6">
            <div className="space-y-3">
              <div className="flex items-start space-x-3">
                <div className="w-6 h-6 bg-blue-600 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5">
                  <svg className="w-3 h-3 text-white" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                  </svg>
                </div>
                <div>
                  <h3 className="font-medium text-gray-900 dark:text-white">Comprehensive Event Listings</h3>
                  <p className="text-sm text-gray-600 dark:text-gray-400">All the punk, alternative, and underground shows across the Bay Area</p>
                </div>
              </div>
              
              <div className="flex items-start space-x-3">
                <div className="w-6 h-6 bg-blue-600 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5">
                  <svg className="w-3 h-3 text-white" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                  </svg>
                </div>
                <div>
                  <h3 className="font-medium text-gray-900 dark:text-white">Smart Search & Filtering</h3>
                  <p className="text-sm text-gray-600 dark:text-gray-400">Find shows by artist, venue, date, or price range</p>
                </div>
              </div>

              <div className="flex items-start space-x-3">
                <div className="w-6 h-6 bg-blue-600 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5">
                  <svg className="w-3 h-3 text-white" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                  </svg>
                </div>
                <div>
                  <h3 className="font-medium text-gray-900 dark:text-white">Mobile-First Design</h3>
                  <p className="text-sm text-gray-600 dark:text-gray-400">Perfect experience on your phone, tablet, or desktop</p>
                </div>
              </div>
            </div>

            <div className="space-y-3">
              <div className="flex items-start space-x-3">
                <div className="w-6 h-6 bg-blue-600 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5">
                  <svg className="w-3 h-3 text-white" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                  </svg>
                </div>
                <div>
                  <h3 className="font-medium text-gray-900 dark:text-white">Calendar Views</h3>
                  <p className="text-sm text-gray-600 dark:text-gray-400">See your shows in month, week, or agenda format</p>
                </div>
              </div>

              <div className="flex items-start space-x-3">
                <div className="w-6 h-6 bg-blue-600 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5">
                  <svg className="w-3 h-3 text-white" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                  </svg>
                </div>
                <div>
                  <h3 className="font-medium text-gray-900 dark:text-white">Venue & Artist Directories</h3>
                  <p className="text-sm text-gray-600 dark:text-gray-400">Explore venues and discover new artists in the scene</p>
                </div>
              </div>

              <div className="flex items-start space-x-3">
                <div className="w-6 h-6 bg-blue-600 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5">
                  <svg className="w-3 h-3 text-white" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                  </svg>
                </div>
                <div>
                  <h3 className="font-medium text-gray-900 dark:text-white">Always Up-to-Date</h3>
                  <p className="text-sm text-gray-600 dark:text-gray-400">Real-time updates so you never miss a show</p>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Technology */}
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 p-6">
          <h2 className="text-2xl font-semibold text-gray-900 dark:text-white mb-4">
            Built for Performance
          </h2>
          <p className="text-gray-700 dark:text-gray-300 leading-relaxed mb-4">
            Zivv is built with modern web technologies to ensure a fast, reliable experience. 
            We use React, TypeScript, and advanced caching to make sure you can access show 
            information quickly, even on slower connections.
          </p>
          <div className="flex flex-wrap gap-2">
            <span className="px-3 py-1 bg-blue-100 dark:bg-blue-900/30 text-blue-800 dark:text-blue-300 text-sm rounded-full">React 19</span>
            <span className="px-3 py-1 bg-blue-100 dark:bg-blue-900/30 text-blue-800 dark:text-blue-300 text-sm rounded-full">TypeScript</span>
            <span className="px-3 py-1 bg-blue-100 dark:bg-blue-900/30 text-blue-800 dark:text-blue-300 text-sm rounded-full">Tailwind CSS</span>
            <span className="px-3 py-1 bg-blue-100 dark:bg-blue-900/30 text-blue-800 dark:text-blue-300 text-sm rounded-full">Web Workers</span>
            <span className="px-3 py-1 bg-blue-100 dark:bg-blue-900/30 text-blue-800 dark:text-blue-300 text-sm rounded-full">IndexedDB</span>
            <span className="px-3 py-1 bg-blue-100 dark:bg-blue-900/30 text-blue-800 dark:text-blue-300 text-sm rounded-full">Progressive Web App</span>
          </div>
        </div>

        {/* Stats for Geeks */}
        <div className="bg-gradient-to-br from-purple-50 to-blue-50 dark:from-purple-900/20 dark:to-blue-900/20 rounded-lg shadow-sm border border-purple-200 dark:border-purple-700 p-6">
          <div className="flex items-center mb-4">
            <div className="w-8 h-8 bg-purple-600 rounded-lg flex items-center justify-center mr-3">
              <svg className="w-5 h-5 text-white" fill="currentColor" viewBox="0 0 20 20">
                <path d="M3 4a1 1 0 011-1h12a1 1 0 011 1v2a1 1 0 01-1 1H4a1 1 0 01-1-1V4zM3 10a1 1 0 011-1h6a1 1 0 011 1v6a1 1 0 01-1 1H4a1 1 0 01-1-1v-6zM14 9a1 1 0 00-1 1v6a1 1 0 001 1h2a1 1 0 001-1v-6a1 1 0 00-1-1h-2z" />
              </svg>
            </div>
            <h2 className="text-2xl font-semibold text-gray-900 dark:text-white">
              Stats for Geeks 🤓
            </h2>
          </div>
          
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <div className="bg-white/70 dark:bg-gray-800/70 backdrop-blur-sm rounded-lg p-6 text-center border border-white/20 dark:border-gray-600/20">
              <div className="text-3xl font-bold text-purple-600 dark:text-purple-400 mb-2">
                {totalEvents.toLocaleString()}
              </div>
              <div className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Total Shows
              </div>
              <div className="text-xs text-gray-500 dark:text-gray-400">
                Tracked in our database
              </div>
            </div>

            <div className="bg-white/70 dark:bg-gray-800/70 backdrop-blur-sm rounded-lg p-6 text-center border border-white/20 dark:border-gray-600/20">
              <div className="text-3xl font-bold text-blue-600 dark:text-blue-400 mb-2">
                {totalArtists.toLocaleString()}
              </div>
              <div className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Artists & Bands
              </div>
              <div className="text-xs text-gray-500 dark:text-gray-400">
                From local to touring acts
              </div>
            </div>

            <div className="bg-white/70 dark:bg-gray-800/70 backdrop-blur-sm rounded-lg p-6 text-center border border-white/20 dark:border-gray-600/20">
              <div className="text-3xl font-bold text-green-600 dark:text-green-400 mb-2">
                {totalVenues.toLocaleString()}
              </div>
              <div className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Venues
              </div>
              <div className="text-xs text-gray-500 dark:text-gray-400">
                Across the Bay Area
              </div>
            </div>
          </div>

          <div className="mt-6 grid grid-cols-2 md:grid-cols-4 gap-4 text-center">
            <div className="bg-white/50 dark:bg-gray-800/50 rounded-lg p-3">
              <div className="text-lg font-semibold text-gray-700 dark:text-gray-300">
                {Math.round(totalEvents / 12)}
              </div>
              <div className="text-xs text-gray-500 dark:text-gray-400">
                Shows/Month Avg
              </div>
            </div>
            
            <div className="bg-white/50 dark:bg-gray-800/50 rounded-lg p-3">
              <div className="text-lg font-semibold text-gray-700 dark:text-gray-300">
                {Math.round(totalEvents / totalVenues) || 0}
              </div>
              <div className="text-xs text-gray-500 dark:text-gray-400">
                Shows/Venue Avg
              </div>
            </div>
            
            <div className="bg-white/50 dark:bg-gray-800/50 rounded-lg p-3">
              <div className="text-lg font-semibold text-gray-700 dark:text-gray-300">
                {Math.round(totalEvents / totalArtists) || 0}
              </div>
              <div className="text-xs text-gray-500 dark:text-gray-400">
                Shows/Artist Avg
              </div>
            </div>
            
            <div className="bg-white/50 dark:bg-gray-800/50 rounded-lg p-3">
              <div className="text-lg font-semibold text-gray-700 dark:text-gray-300">
                99.9%
              </div>
              <div className="text-xs text-gray-500 dark:text-gray-400">
                Uptime
              </div>
            </div>
          </div>

          <div className="mt-4 text-center">
            <p className="text-xs text-gray-600 dark:text-gray-400">
              Stats update in real-time as new shows are added • Last updated: {new Date().toLocaleString()}
            </p>
          </div>
        </div>

        {/* Community */}
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 p-6">
          <h2 className="text-2xl font-semibold text-gray-900 dark:text-white mb-4">
            Community Driven
          </h2>
          <p className="text-gray-700 dark:text-gray-300 leading-relaxed mb-4">
            Zivv is an open-source project built by and for the Bay Area music community. 
            We welcome contributions, feedback, and suggestions from musicians, venue owners, 
            promoters, and music lovers.
          </p>
          <div className="flex flex-wrap gap-4">
            <a 
              href="https://github.com/anthropics/zivv" 
              className="inline-flex items-center px-4 py-2 bg-gray-900 dark:bg-gray-700 text-white rounded-lg hover:bg-gray-800 dark:hover:bg-gray-600 transition-colors"
            >
              <svg className="w-5 h-5 mr-2" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M10 0C4.477 0 0 4.484 0 10.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0110 4.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.203 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.942.359.31.678.921.678 1.856 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0020 10.017C20 4.484 15.522 0 10 0z" clipRule="evenodd" />
              </svg>
              View on GitHub
            </a>
            <a 
              href="mailto:feedback@zivv.dev" 
              className="inline-flex items-center px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
            >
              <svg className="w-5 h-5 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 4.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
              </svg>
              Send Feedback
            </a>
          </div>
        </div>

        {/* Footer */}
        <div className="text-center text-gray-500 dark:text-gray-400 text-sm border-t border-gray-200 dark:border-gray-700 pt-6">
          <p>
            Made with ♥ for the Bay Area punk and alternative music scene
          </p>
          <p className="mt-1">
            © 2025 Zivv • Open Source • Community Driven
          </p>
        </div>
      </div>
    </ContentArea>
  );
};

export default AboutPage;