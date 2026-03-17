// C:\Users\LENOVO\Desktop\SISI_KWA_SISI\server.js
require("dotenv").config();
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const axios = require('axios');
const moment = require('moment');
const mongoose = require("mongoose");
const cloudinary = require('cloudinary').v2;

const app = express();
app.use(cors());
app.use(express.json());
mongoose.connect(process.env.MONGO_URI)
.then(() => console.log("✅ MongoDB Connected"))
.catch(err => console.error(err));

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

const fundraiserSchema = new mongoose.Schema({
  id: String,
  title: String,
  name: String,
  images: [String],
  target: Number,
  shortDesc: String,
  fullDesc: String,
  LipaNaMpesa: {
    Paybill: String,
    Account: String
  }
});

const Fundraiser = mongoose.model("Fundraiser", fundraiserSchema);

const donationSchema = new mongoose.Schema({
  fundraiserId: String,
  checkoutId: String,
  amount: Number,
  phone: Number,
  status: String,
  receipt: String,
  date: Date
}, { versionKey: false }); // removes __v

const Donation = mongoose.model("Donation", donationSchema);

app.get("/", (req, res) => {
  res.send("Sisi Kwa Sisi API running 🚀");
});

/* ===============================
   M-PESA PRODUCTION CONFIG
================================ */

//const consumerKey = "YOUR_CONSUMER_KEY";
//const consumerSecret = "YOUR_CONSUMER_SECRET";

//const shortCode = "YOUR_PAYBILL"; 
//const passKey = "YOUR_PASSKEY";
const consumerKey = process.env.MPESA_CONSUMER_KEY;
const consumerSecret = process.env.MPESA_CONSUMER_SECRET;
const shortCode = process.env.MPESA_SHORTCODE;
const passKey = process.env.MPESA_PASSKEY;
const callbackURL = process.env.MPESA_CALLBACK;

/* ===============================
   STATIC IMAGE SERVING
================================ */

app.use('/images', express.static(path.join(__dirname, 'images')));

/* ===============================
   ENSURE FOLDERS EXIST
================================ */

const imagesDir = path.join(__dirname, 'images');
if (!fs.existsSync(imagesDir)) fs.mkdirSync(imagesDir);

const fundraiserFile = path.join(__dirname, 'fundraisers.json');
const donationsFile = path.join(__dirname, 'donations.json');

if (!fs.existsSync(fundraiserFile)) fs.writeFileSync(fundraiserFile, JSON.stringify([], null, 2));
if (!fs.existsSync(donationsFile)) fs.writeFileSync(donationsFile, JSON.stringify([], null, 2));

/* ===============================
   MULTER IMAGE STORAGE
================================ */

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, imagesDir);
  },
  filename: function (req, file, cb) {
    const fundraiserId = req.body.id;
    const ext = path.extname(file.originalname);
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e6);
    cb(null, `${fundraiserId}_${uniqueSuffix}${ext}`);
  }
});

const upload = multer({ storage });

/* ===============================
   UPLOAD FUNDRAISER
================================ */

app.post('/upload', upload.array('images', 10), async (req, res) => {


  const { id, title, name, target, shortDesc, fullDesc, paybill, account } = req.body;

  const images = [];

for (let file of req.files) {
  const result = await cloudinary.uploader.upload(file.path);
  images.push(result.secure_url);
}


  const newFundraiser = new Fundraiser({
  id,
  title,
  name,
  target,
  shortDesc,
  fullDesc,
  LipaNaMpesa: {
    Paybill: paybill,
    Account: account
  },
  images
});

await newFundraiser.save();


  res.json({ message: "Fundraiser uploaded successfully" });

});

/* ===============================
   GET ALL FUNDRAISERS
================================ */

app.get('/fundraisers.json', async (req, res) => {

  const fundraisers = await Fundraiser.find();
res.json(fundraisers);


});

/* ===============================
   M-PESA ACCESS TOKEN
================================ */

async function getAccessToken() {

  const url = "https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials";

  const auth = Buffer.from(consumerKey + ":" + consumerSecret).toString("base64");

  const response = await axios.get(url, {
    headers: {
      Authorization: `Basic ${auth}`
    }
  });

  return response.data.access_token;

}

/* ===============================
   DONATE (TRIGGER STK PUSH)
================================ */

app.post("/donate", async (req, res) => {

  const { fundraiserId, paybill, account, amount, phone, name } = req.body;
  let formattedPhone = phone;

if (formattedPhone.startsWith("0")) {
  formattedPhone = "254" + formattedPhone.substring(1);
}

if (formattedPhone.startsWith("+")) {
  formattedPhone = formattedPhone.substring(1);
}


  try {

    const token = await getAccessToken();

    const timestamp = moment().format("YYYYMMDDHHmmss");

    const password = Buffer.from(shortCode + passKey + timestamp).toString("base64");

    const stkPush = await axios.post(
  "https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest",
  {
    BusinessShortCode: shortCode,
    Password: password,
    Timestamp: timestamp,
    TransactionType: "CustomerPayBillOnline",
    Amount: amount,
    PartyA: formattedPhone,
    PartyB: shortCode,
    PhoneNumber: formattedPhone,
    CallBackURL: callbackURL,
    AccountReference: fundraiserId,
    TransactionDesc: "Sisi Kwa Sisi Donation"
  },

      {
        headers: {
          Authorization: `Bearer ${token}`
        }
      }
    );

    const checkoutId = stkPush.data.CheckoutRequestID;

await Donation.create({
  fundraiserId,
  checkoutId,
  amount,
  phone: Number(formattedPhone),
  status: "pending",
  date: new Date()
});


res.json({
  success: true,
  message: "STK Push sent",
  data: stkPush.data
});


  } catch (err) {

    console.error(err.response?.data || err);

    res.json({
      success: false,
      message: "Payment request failed"
    });

  }

});

/* ===============================
   M-PESA CALLBACK
================================ */

app.post("/mpesa/callback", async (req, res) => {

  const body = req.body;

  console.log("MPESA CALLBACK RECEIVED");

  try {

    const stk = body.Body.stkCallback;

    if (stk.ResultCode === 0) {

      const metadata = stk.CallbackMetadata.Item;

      const amount = metadata.find(x => x.Name === "Amount").Value;
      const receipt = metadata.find(x => x.Name === "MpesaReceiptNumber").Value;
      const phone = metadata.find(x => x.Name === "PhoneNumber").Value;
     const checkoutId = stk.CheckoutRequestID;

await Donation.findOneAndUpdate(
  { checkoutId },
  {
    receipt,
    amount,
    phone,
    status: "completed",
    date: new Date()
  }
);


console.log("Donation updated");


    }

  } catch (err) {

    console.error("Callback processing error:", err);

  }

  res.json({ ResultCode: 0 });

});
/* ===============================
   GET FUNDRAISER TOTAL
================================ */

app.get("/fundraiser/:id/total", async (req, res) => {


  const fundraiserId = req.params.id;

  const donations = await Donation.find({
  fundraiserId,
  status: "completed"
});

const total = donations.reduce((sum, d) => sum + Number(d.amount), 0);


  res.json({
    fundraiserId,
    totalRaised: total
  });

});
/* ===============================
   GET FUNDRAISER DONATIONS
================================ */

app.get("/fundraiser/:id/donations", async (req, res) => {

  const fundraiserId = req.params.id;

 const donations = await Donation.find({
  fundraiserId,
  status: "completed"
}).select("-_id"); // removes _id

res.json(donations);


});

/* ===============================
   START SERVER
================================ */

const PORT = process.env.PORT || 3000;


app.listen(PORT, () => {

  console.log(`✅🚀🚀 Server running on port ${PORT}`);

});
