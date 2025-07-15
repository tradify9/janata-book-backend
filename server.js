const express = require('express');
const axios = require('axios');
const cors = require('cors');
const winston = require('winston');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

// Configure Winston logger
const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
    ),
    transports: [
        new winston.transports.File({ filename: 'error.log', level: 'error' }),
        new winston.transports.File({ filename: 'combined.log' }),
        new winston.transports.Console()
    ]
});

// Middleware to enable CORS for all origins
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

// Middleware to parse JSON bodies
app.use(express.json());

// ✅ Route to get public IP of server (for Shiprocket whitelisting)
app.get('/my-ip', async (req, res) => {
    try {
        const response = await axios.get('https://api64.ipify.org?format=json');
        res.json(response.data); // { ip: "xxx.xxx.xxx.xxx" }
    } catch (error) {
        logger.error('Failed to fetch public IP address', { error: error.message });
        res.status(500).json({ error: 'Failed to fetch public IP' });
    }
});

// Root route
app.get('/', (req, res) => {
    res.status(200).send('Server is running');
});

// Health check endpoint
app.get('/health', (req, res) => {
    logger.info('Health check endpoint called');
    res.status(200).json({ status: 'OK', message: 'Server is running' });
});

// Shiprocket API configuration
const shiprocketConfig = {
    token: process.env.SHIPROCKET_TOKEN || 'your-default-shiprocket-token-here',
    apiUrl: 'https://apiv2.shiprocket.in'
};

// Endpoint to handle order creation
app.post('/api/create-order', async (req, res) => {
    try {
        const {
            orderId,
            cart,
            formData,
            totalAmount,
            shippingCost,
            couponDiscount,
            paymentId,
            deliveryDays
        } = req.body;

        if (!orderId || !cart || !Array.isArray(cart) || cart.length === 0 || !formData || !paymentId) {
            logger.error('Invalid order data received', {
                orderId,
                cartLength: cart?.length,
                formData,
                totalAmount,
                paymentId
            });
            return res.status(400).json({ success: false, error: 'Missing required order data' });
        }

        if (!formData.name || !formData.email || !formData.phone || !formData.address || !formData.pincode || !formData.state) {
            logger.error('Incomplete form data', { formData });
            return res.status(400).json({ success: false, error: 'Incomplete shipping details' });
        }

        const invalidItem = cart.find(item => !item.id || !item.name || !Number.isFinite(item.price) || !Number.isFinite(item.quantity) || item.quantity <= 0);
        if (invalidItem) {
            logger.error('Invalid cart item detected', { invalidItem });
            return res.status(400).json({ success: false, error: 'Invalid cart item data' });
        }

        if (!Number.isFinite(totalAmount) || totalAmount < 0) {
            logger.error('Invalid total amount', { totalAmount });
            return res.status(400).json({ success: false, error: 'Total amount must be a valid non-negative number' });
        }
        if (totalAmount === 0) {
            logger.warn('Total amount is zero, proceeding with warning', { orderId, totalAmount });
        }

        const orderItems = cart.map(item => ({
            name: item.name,
            sku: `SKU-${item.id}`,
            units: item.quantity,
            selling_price: item.price,
            discount: 0,
            tax: 0,
            hsn: '4901' // Books
        }));

        logger.info('Cart details', { cart, orderItems });

        const orderDate = new Date().toISOString().split('T')[0];
        const payload = {
            order_id: orderId,
            order_date: orderDate,
            pickup_location: process.env.SHIPROCKET_PICKUP_LOCATION || 'Primary',
            channel_id: '',
            comment: 'Order from Janata Books Point',
            billing_customer_name: formData.name,
            billing_last_name: '',
            billing_address: formData.address,
            billing_city: formData.city || '',
            billing_pincode: formData.pincode,
            billing_state: formData.state,
            billing_country: 'India',
            billing_email: formData.email,
            billing_phone: formData.phone,
            shipping_is_billing: true,
            shipping_customer_name: formData.name,
            shipping_last_name: '',
            shipping_address: formData.address,
            shipping_city: formData.city || '',
            shipping_pincode: formData.pincode,
            shipping_country: 'India',
            shipping_state: formData.state,
            shipping_email: formData.email,
            shipping_phone: formData.phone,
            order_items: orderItems,
            payment_method: 'Prepaid',
            shipping_charges: shippingCost || 0,
            giftwrap_charges: 0,
            transaction_charges: 0,
            total_discount: couponDiscount || 0,
            sub_total: totalAmount,
            length: 30,
            breadth: 20,
            height: 5,
            weight: 0.5 * cart.reduce((sum, item) => sum + item.quantity, 0)
        };

        logger.info('Sending order to Shiprocket', { orderId, totalAmount, itemCount: cart.length, payload });

        const response = await axios.post(
            `${shiprocketConfig.apiUrl}/v1/external/orders/create/adhoc`,
            payload,
            {
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${shiprocketConfig.token}`
                },
                timeout: 10000
            }
        );

        logger.info('Shiprocket order created successfully', { orderId, shiprocketOrderId: response.data.order_id });

        res.json({
            success: true,
            shiprocketOrderId: response.data.order_id,
            message: 'Order created successfully in Shiprocket'
        });
    } catch (error) {
        logger.error('Error creating Shiprocket order', {
            error: error.message,
            response: error.response ? {
                status: error.response.status,
                data: error.response.data
            } : null
        });

        if (error.response) {
            const { status, data } = error.response;
            if (status === 401) {
                return res.status(401).json({
                    success: false,
                    error: 'Shiprocket authentication failed',
                    details: 'Invalid or expired Shiprocket token'
                });
            }
            if (status === 422) {
                return res.status(422).json({
                    success: false,
                    error: 'Invalid order data for Shiprocket',
                    details: data
                });
            }
        }

        res.status(500).json({
            success: false,
            error: 'Failed to create order in Shiprocket',
            details: error.message
        });
    }
});

// Global error handler
app.use((err, req, res, next) => {
    logger.error('Server error', { error: err.message, stack: err.stack });
    res.status(500).json({
        success: false,
        error: 'Internal server error',
        details: err.message
    });
});

// Start the server
app.listen(port, () => {
    logger.info(`Server running on port ${port}`);
});
