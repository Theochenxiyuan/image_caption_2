const express = require('express');
const multer = require('multer');
const path = require('path');
const dotenv = require('dotenv');
const fs = require('fs');
const mysql = require('mysql2/promise');

const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const {
  SecretsManagerClient,
  GetSecretValueCommand,
} = require('@aws-sdk/client-secrets-manager');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

app.set('view engine', 'ejs');
app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));

const upload = multer({ storage: multer.memoryStorage() });

// Create reusable AWS clients
const s3Client = new S3Client({ region: process.env.S3_REGION });
const secretsClient = new SecretsManagerClient({ region: 'us-east-1' });

// Function to get DB credentials from Secrets Manager and connect
const db = async () => {
  const secretName = process.env.DB_SECRET_NAME;

  const data = await secretsClient.send(
    new GetSecretValueCommand({ SecretId: secretName })
  );

  let secret;
  if ('SecretString' in data) {
    secret = JSON.parse(data.SecretString);
  } else {
    const buff = Buffer.from(data.SecretBinary, 'base64');
    secret = JSON.parse(buff.toString('ascii'));
  }

  return mysql.createConnection({
    host: secret.host,
    database: secret.dbname,
    user: secret.username,
    password: secret.password,
  });
};

app.get('/', (req, res) => {
  res.render('index', { message: null });
});

app.get('/gallery', async (req, res) => {
  try {
    const conn = await db();
    const [rows] = await conn.execute(
      'SELECT image_key, thumbnail_key, caption FROM captions ORDER BY uploaded_at DESC'
    );
    await conn.end();

    const images = await Promise.all(
      rows.map(async (row) => {
        const originalUrl = await getSignedUrl(
          s3Client,
          new GetObjectCommand({
            Bucket: process.env.S3_BUCKET,
            Key: row.image_key,
          }),
          { expiresIn: 3600 }
        );

        const thumbnailUrl = await getSignedUrl(
          s3Client,
          new GetObjectCommand({
            Bucket: process.env.S3_BUCKET,
            Key: row.thumbnail_key,
          }),
          { expiresIn: 3600 }
        );

        return {
          originalUrl,
          thumbnailUrl,
          caption: row.caption,
        };
      })
    );

    res.render('gallery', { images });
  } catch (err) {
    console.error(err);
    res.render('gallery', { error: err.message });
  }
});

app.post('/upload', upload.single('file'), async (req, res) => {
  const file = req.file;
  if (!file) return res.render('upload', { error: 'No file uploaded' });

  const fileName = file.originalname;
  const mimeType = file.mimetype;

  try {
    // Upload to S3
    await s3Client.send(
      new PutObjectCommand({
        Bucket: process.env.S3_BUCKET,
        Key: `uploads/${fileName}`,
        Body: file.buffer,
        ContentType: mimeType,
      })
    );

    // Optionally: Insert into DB if needed here

    const base64Image = file.buffer.toString('base64');
    res.render('upload', {
      image_data: base64Image,
      error: null,
    });
  } catch (err) {
    console.error(err);
    return res.render('upload', { error: 'S3 Upload Error: ' + err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
