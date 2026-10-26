#!/usr/bin/env node

import 'dotenv/config';
import nodemailer from 'nodemailer';

const requiredSettings = ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'NOTIFICATION_FROM'];
const missingSettings = requiredSettings.filter((setting) => !process.env[setting]?.trim());

if (missingSettings.length) {
  console.error(`SMTP configuration is incomplete. Set: ${missingSettings.join(', ')}.`);
  process.exitCode = 1;
} else {
  const port = Number(process.env.SMTP_PORT || 587);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error('SMTP_PORT must be an integer between 1 and 65535.');
    process.exitCode = 1;
  } else {
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      secure: String(process.env.SMTP_SECURE).toLowerCase() === 'true',
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 15_000,
    });

    try {
      await transporter.verify();
      console.log('SMTP connection and authentication verified. No email was sent.');
    } catch (error) {
      console.error(`SMTP verification failed: ${error.code || error.name} ${error.message}`);
      process.exitCode = 1;
    } finally {
      transporter.close();
    }
  }
}
