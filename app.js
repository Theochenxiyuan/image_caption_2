const express = require('express');
const multer = require('multer');
const aws = require('aws-sdk');
const mysql = require('mysql2/promise');
const path = require('path');
const dotenv = require('dotenv');
const fs = require('fs');
const app = express();

dotenv.config();

const PORT = process.env.PORT || 5000;

app.set('view engine', 'ejs');
app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));

const upload = multer({ storage: multer.memoryStorage() });

const s3 = new aws.S3({
  region: process.env.S3_REGION,
});

const secretName = process.env.DB_SECRET_NAME;

const db = async () => {
  const client = new aws.SecretsManager({ region: 'us-east-1' });

  const secretData = await client
    .getSecretValue({ SecretId: secretName })
    .promise();

  let secret;
  if ('SecretString' in secretData) {
    secret = JSON.parse(secretData.SecretString);
  } else {
    const buff = Buffer.from(secretData.SecretBinary, 'base64');
    secret = JSON.parse(buff.toString('ascii'));
  }

  // Use the secrets to establish the DB connection
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

    console.log('Rows:', rows);
    const images = rows.map((row) => {
      console.log('Bucket env:', process.env.S3_BUCKET);
      console.log('First image key:', rows[0]?.image_key);
      return {
        originalUrl: s3.getSignedUrl('getObject', {
          Bucket: process.env.S3_BUCKET,
          Key: row.image_key,
          Expires: 3600,
        }),
        thumbnailUrl: s3.getSignedUrl('getObject', {
          Bucket: process.env.S3_BUCKET,
          Key: row.thumbnail_key,
          Expires: 3600,
        }),
        caption: row.caption,
      };
    });

    res.render('gallery', { images });
  } catch (err) {
    res.render('gallery', { error: err.message });
  }
});

app.post('/upload', upload.single('file'), async (req, res) => {
  const file = req.file;
  if (!file) return res.render('upload', { error: 'No file uploaded' });

  const fileName = file.originalname;
  const mimeType = file.mimetype;

  // Upload to S3
  try {
    await s3
      .upload({
        Bucket: process.env.S3_BUCKET,
        Key: `uploads/${fileName}`,
        Body: file.buffer,
        ContentType: mimeType,
      })
      .promise();
  } catch (err) {
    return res.render('upload', { error: 'S3 Upload Error: ' + err.message });
  }

  const base64Image = file.buffer.toString('base64');
  res.render('upload', {
    image_data: base64Image,
    error: null,
  });
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
